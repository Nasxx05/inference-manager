import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrbioConnectionService } from "../server/src/orbioConnectionService";
import { PersistenceError, decryptOrbioKey, encryptOrbioKey, readOrbioConnection, requireCredentialEncryptionKey, saveOrbioConnection, type OrbioConnectionRecord } from "../server/src/persistence";
import { isUsableOrbioStatus } from "@/lib/guidedApi";

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);

function memoryService(input: {
  verify?: (key: string) => Promise<{ modelIds: string[] }>;
  decrypt?: (value: string) => string;
} = {}) {
  const rows = new Map<string, OrbioConnectionRecord>();
  const providerKeys: string[] = [];
  const verify = input.verify ?? (async (key: string) => {
    providerKeys.push(key);
    return { modelIds: ["openai/gpt-4o"] };
  });
  let epoch = 1_000;
  let balanceCalls = 0;
  const service = createOrbioConnectionService({
    read: async (userId) => rows.get(userId) ?? null,
    save: async (record) => { rows.set(record.userId, { ...record }); return { ...record }; },
    updateStatus: async (userId, status, lastVerifiedAt) => {
      const current = rows.get(userId);
      if (current) rows.set(userId, { ...current, status, ...(lastVerifiedAt ? { lastVerifiedAt } : {}) });
    },
    remove: async (userId) => { rows.delete(userId); },
    ...(input.decrypt ? { decrypt: input.decrypt } : {}),
    verify,
    balance: async () => { balanceCalls += 1; return { available: 12.5, currency: "CREDIT", source: "credits" }; },
    requireEncryption: () => process.env.CREDENTIAL_ENCRYPTION_KEY!,
    now: () => "2026-09-27T12:00:00.000Z",
    epochNow: () => epoch,
  });
  return { service, rows, providerKeys, get balanceCalls() { return balanceCalls; }, advance(ms: number) { epoch += ms; } };
}

beforeEach(() => { process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_A; });
afterEach(() => {
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.ORBIO_STATUS_CACHE_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Orbio persisted credential lifecycle", () => {
  it("fails clearly when the stable 32-byte encryption key is missing or malformed", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "generated-or-short";
    expect(() => requireCredentialEncryptionKey()).toThrowError(expect.objectContaining({ code: "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" }));
  });

  it("connects with one remote verification and confirms persisted decryption locally", async () => {
    const { service, rows, providerKeys } = memoryService();
    const result = await service.connect("user-1", "orbio-secret");

    const saved = rows.get("user-1");
    expect(saved?.status).toBe("active");
    expect(saved?.encryptedKey).not.toContain("orbio-secret");
    expect(decryptOrbioKey(saved!.encryptedKey)).toBe("orbio-secret");
    expect(providerKeys).toEqual(["orbio-secret"]);
    expect(result).toMatchObject({ modelIds: ["openai/gpt-4o"], balance: { available: 12.5 } });
  });

  it("uses the Supabase upsert representation and can read the canonical row back", async () => {
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    let stored: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        stored = (JSON.parse(String(init.body)) as Array<Record<string, unknown>>)[0];
        return new Response(JSON.stringify([stored]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(stored ? [stored] : []), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const encryptedKey = encryptOrbioKey("orbio-secret");

    await saveOrbioConnection({ userId: "user-db", encryptedKey, keyFingerprint: "fingerprint", status: "active", lastVerifiedAt: "2026-09-27T12:00:00.000Z" });
    const loaded = await readOrbioConnection("user-db");

    expect(loaded).toMatchObject({ userId: "user-db", status: "active", keyFingerprint: "fingerprint" });
    expect(decryptOrbioKey(loaded!.encryptedKey)).toBe("orbio-secret");
  });

  it("prevents a false connected response when round-trip decryption fails", async () => {
    const { service } = memoryService({ decrypt: () => { throw new Error("cannot decrypt"); } });
    await expect(service.connect("user-1", "orbio-secret")).rejects.toMatchObject({ code: "ORBIO_CREDENTIAL_UNREADABLE" });
  });

  it("keeps missing, inactive and unreadable states distinct", async () => {
    const missing = memoryService();
    await expect(missing.service.loadCredentialForInference("missing-user")).rejects.toMatchObject({ code: "ORBIO_NOT_CONNECTED" });

    const inactive = memoryService();
    inactive.rows.set("user-2", { userId: "user-2", encryptedKey: "cipher", keyFingerprint: "fp", status: "unverified" });
    await expect(inactive.service.loadCredentialForInference("user-2")).rejects.toMatchObject({ code: "ORBIO_CONNECTION_INACTIVE" });

    const unreadable = memoryService({ decrypt: () => { throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "unreadable", 400); } });
    unreadable.rows.set("user-3", { userId: "user-3", encryptedKey: "cipher", keyFingerprint: "fp", status: "active" });
    await expect(unreadable.service.loadCredentialForInference("user-3")).rejects.toMatchObject({ code: "ORBIO_CREDENTIAL_UNREADABLE" });
  });

  it("marks a saved connection invalid when Orbio rejects its decrypted key", async () => {
    const { service, rows } = memoryService({ verify: async () => { throw new PersistenceError("ORBIO_KEY_INVALID", "rejected", 400); } });
    const seeded = memoryService();
    await seeded.service.connect("user-4", "orbio-secret");
    rows.set("user-4", seeded.rows.get("user-4")!);

    await expect(service.verifyConnection("user-4")).rejects.toMatchObject({ code: "ORBIO_KEY_EXPIRED_OR_INVALID" });
    expect(rows.get("user-4")?.status).toBe("invalid");
  });

  it("survives a service restart with the same encryption key", async () => {
    const first = memoryService();
    await first.service.connect("user-5", "orbio-secret");
    const second = memoryService();
    second.rows.set("user-5", first.rows.get("user-5")!);

    const status = await second.service.status("user-5");
    expect(status).toMatchObject({ connected: true, status: "active", balance: null });
  });

  it("returns unreadable rather than not-connected when the encryption key changes", async () => {
    const first = memoryService();
    await first.service.connect("user-6", "orbio-secret");
    const second = memoryService();
    second.rows.set("user-6", first.rows.get("user-6")!);
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_B;

    await expect(second.service.loadCredentialForInference("user-6")).rejects.toMatchObject({ code: "ORBIO_CREDENTIAL_UNREADABLE" });
  });

  it("loads inference credentials without model verification or balance lookup", async () => {
    const fixture = memoryService();
    await fixture.service.connect("user-hot", "orbio-secret");
    fixture.providerKeys.length = 0;
    const priorBalanceCalls = fixture.balanceCalls;

    await expect(fixture.service.loadCredentialForInference("user-hot")).resolves.toMatchObject({ apiKey: "orbio-secret" });
    expect(fixture.providerKeys).toEqual([]);
    expect(fixture.balanceCalls).toBe(priorBalanceCalls);
  });

  it("uses safe cached status until its TTL expires", async () => {
    process.env.ORBIO_STATUS_CACHE_MS = "120000";
    const fixture = memoryService();
    await fixture.service.connect("user-cache", "orbio-secret");
    fixture.providerKeys.length = 0;

    const cached = await fixture.service.status("user-cache");
    expect(cached).not.toHaveProperty("apiKey");
    expect(JSON.stringify(cached)).not.toContain("orbio-secret");
    expect(fixture.providerKeys).toEqual([]);

    const balanceCallsBeforeRefresh = fixture.balanceCalls;
    fixture.advance(120001);
    await fixture.service.status("user-cache");
    expect(fixture.providerKeys).toEqual(["orbio-secret"]);
    expect(fixture.balanceCalls).toBe(balanceCallsBeforeRefresh);
    await fixture.service.balance("user-cache", true);
    expect(fixture.balanceCalls).toBe(balanceCallsBeforeRefresh + 1);
    delete process.env.ORBIO_STATUS_CACHE_MS;
  });
});

describe("frontend Orbio usability contract", () => {
  it.each([
    [{ connected: true, status: "active" as const }, true],
    [{ connected: true, status: "invalid" as const }, false],
    [{ connected: true, status: undefined as unknown as "active" }, false],
    [{ connected: false, status: "disconnected" as const }, false],
  ])("requires connected=true and status=active", (status, expected) => {
    expect(isUsableOrbioStatus(status)).toBe(expected);
  });
});
