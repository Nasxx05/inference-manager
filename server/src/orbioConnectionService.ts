import { createHash } from "node:crypto";
import {
  PersistenceError,
  decryptOrbioKey,
  deleteOrbioConnection,
  encryptOrbioKey,
  fingerprint,
  readOrbioConnection,
  requireCredentialEncryptionKey,
  saveOrbioConnection,
  updateOrbioConnectionStatus,
  type OrbioConnectionRecord,
} from "./persistence";
import { getOrbioBalance, verifyOrbioKey, type OrbioBalance } from "./orbioService";

export interface OrbioInferenceCredential {
  /** Backend-memory only. Never cache or serialize this object. */
  apiKey: string;
  fingerprint: string;
}

export interface VerifiedOrbioConnection extends OrbioInferenceCredential {
  modelIds: string[];
  balance: OrbioBalance | null;
}

export interface SafeOrbioStatus {
  connected: boolean;
  status: OrbioConnectionRecord["status"];
  keyFingerprint?: string;
  modelIds: string[];
  balance: OrbioBalance | null;
}

interface SafeCacheEntry extends SafeOrbioStatus {
  fetchedAt: number;
  balanceFetchedAt?: number;
}

interface ConnectionDependencies {
  read: typeof readOrbioConnection;
  save: typeof saveOrbioConnection;
  updateStatus: typeof updateOrbioConnectionStatus;
  remove: typeof deleteOrbioConnection;
  encrypt: typeof encryptOrbioKey;
  decrypt: typeof decryptOrbioKey;
  verify: typeof verifyOrbioKey;
  balance: typeof getOrbioBalance;
  requireEncryption: typeof requireCredentialEncryptionKey;
  now: () => string;
  epochNow: () => number;
}

const defaults: ConnectionDependencies = {
  read: readOrbioConnection,
  save: saveOrbioConnection,
  updateStatus: updateOrbioConnectionStatus,
  remove: deleteOrbioConnection,
  encrypt: encryptOrbioKey,
  decrypt: decryptOrbioKey,
  verify: verifyOrbioKey,
  balance: getOrbioBalance,
  requireEncryption: requireCredentialEncryptionKey,
  now: () => new Date().toISOString(),
  epochNow: () => Date.now(),
};

function cacheTtlMs(): number {
  const configured = Number(process.env.ORBIO_STATUS_CACHE_MS ?? 120_000);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 120_000;
}

function safeUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

function log(event: string, userId: string, fields: Record<string, string>): void {
  const details = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ");
  console.info(`[orbio] event=${event} user=${safeUser(userId)} ${details}`.trim());
}

function providerError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError && (error.code === "ORBIO_KEY_INVALID" || error.code === "ORBIO_KEY_EXPIRED_OR_INVALID")) {
    return new PersistenceError("ORBIO_KEY_EXPIRED_OR_INVALID", "Orbio rejected the saved key. Reconnect your key.", 400);
  }
  if (error instanceof PersistenceError && error.code === "ORBIO_NOT_CONFIGURED") return error;
  return new PersistenceError("ORBIO_PROVIDER_UNAVAILABLE", "Orbio is temporarily unavailable. Try again shortly.", 503);
}

function publicStatus(entry: SafeCacheEntry): SafeOrbioStatus {
  return {
    connected: entry.connected,
    status: entry.status,
    ...(entry.keyFingerprint ? { keyFingerprint: entry.keyFingerprint } : {}),
    modelIds: [...entry.modelIds],
    balance: entry.balance,
  };
}

export function createOrbioConnectionService(overrides: Partial<ConnectionDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  // This cache contains metadata only. Plaintext/ciphertext credentials never enter it.
  const metadataCache = new Map<string, SafeCacheEntry>();

  function decryptActiveRecord(userId: string, record: OrbioConnectionRecord): OrbioInferenceCredential {
    if (record.status !== "active") throw new PersistenceError("ORBIO_CONNECTION_INACTIVE", "Your saved Orbio connection is inactive. Reconnect it.", 400);
    if (!record.encryptedKey) throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
    try {
      const apiKey = dependencies.decrypt(record.encryptedKey).trim();
      if (!apiKey) throw new Error("empty credential");
      return { apiKey, fingerprint: record.keyFingerprint };
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED") throw error;
      log("connection_validation", userId, { failure: "credential_decryption" });
      throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
    }
  }

  async function loadActiveRecord(userId: string): Promise<{ record: OrbioConnectionRecord; credential: OrbioInferenceCredential }> {
    dependencies.requireEncryption();
    const record = await dependencies.read(userId);
    if (!record) throw new PersistenceError("ORBIO_NOT_CONNECTED", "Connect your Orbio account before starting a project.", 400);
    return { record, credential: decryptActiveRecord(userId, record) };
  }

  /** Hot path: one DB read plus local decryption, with no provider or balance calls. */
  async function loadCredentialForInference(userId: string): Promise<OrbioInferenceCredential> {
    return (await loadActiveRecord(userId)).credential;
  }

  async function verifyLoaded(userId: string, record: OrbioConnectionRecord, credential: OrbioInferenceCredential, includeBalance = true): Promise<VerifiedOrbioConnection> {
    let verified: Awaited<ReturnType<typeof verifyOrbioKey>>;
    try {
      verified = await dependencies.verify(credential.apiKey);
    } catch (error) {
      const normalized = providerError(error);
      if (normalized.code === "ORBIO_KEY_EXPIRED_OR_INVALID") await markInvalid(userId);
      log("connection_validation", userId, { failure: normalized.code.toLowerCase() });
      throw normalized;
    }
    const verifiedAt = dependencies.now();
    const previous = metadataCache.get(userId);
    const balancePromise = includeBalance ? dependencies.balance(credential.apiKey) : Promise.resolve(previous?.balance ?? null);
    const [balance] = await Promise.all([balancePromise, dependencies.updateStatus(userId, "active", verifiedAt)]);
    const fetchedAt = dependencies.epochNow();
    metadataCache.set(userId, {
      connected: true,
      status: "active",
      keyFingerprint: record.keyFingerprint,
      modelIds: [...verified.modelIds],
      balance,
      fetchedAt,
      ...(includeBalance ? { balanceFetchedAt: fetchedAt } : previous?.balanceFetchedAt !== undefined ? { balanceFetchedAt: previous.balanceFetchedAt } : {}),
    });
    return { ...credential, modelIds: verified.modelIds, balance };
  }

  /** Remote verification for connect, explicit refresh, and TTL status refresh only. */
  async function verifyConnection(userId: string): Promise<VerifiedOrbioConnection> {
    const { record, credential } = await loadActiveRecord(userId);
    return verifyLoaded(userId, record, credential);
  }

  async function markInvalid(userId: string): Promise<void> {
    metadataCache.delete(userId);
    await dependencies.updateStatus(userId, "invalid").catch(() => undefined);
    log("connection_validation", userId, { failure: "orbio_key_expired_or_invalid" });
  }

  async function connect(userId: string, rawApiKey: string): Promise<VerifiedOrbioConnection> {
    dependencies.requireEncryption();
    const apiKey = rawApiKey.trim();
    if (!apiKey) throw new PersistenceError("ORBIO_KEY_EXPIRED_OR_INVALID", "Enter an Orbio API key.", 400);
    let verified: Awaited<ReturnType<typeof verifyOrbioKey>>;
    try {
      verified = await dependencies.verify(apiKey);
      log("connect", userId, { verification: "success" });
    } catch (error) {
      throw providerError(error);
    }

    const now = dependencies.now();
    await dependencies.save({ userId, encryptedKey: dependencies.encrypt(apiKey), keyFingerprint: fingerprint(apiKey), status: "active", lastVerifiedAt: now });
    log("connect", userId, { persistence: "success" });

    // Confirm that the persisted ciphertext can be read, without a second /models call.
    const { record, credential } = await loadActiveRecord(userId);
    if (credential.fingerprint !== fingerprint(apiKey)) throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "The saved Orbio connection could not be confirmed.", 400);
    const balance = await dependencies.balance(credential.apiKey);
    const fetchedAt = dependencies.epochNow();
    metadataCache.set(userId, { connected: true, status: "active", keyFingerprint: record.keyFingerprint, modelIds: [...verified.modelIds], balance, fetchedAt, balanceFetchedAt: fetchedAt });
    log("connect", userId, { roundtrip_decryption: "success" });
    return { ...credential, modelIds: verified.modelIds, balance };
  }

  async function status(userId: string, forceRefresh = false): Promise<SafeOrbioStatus> {
    const cached = metadataCache.get(userId);
    if (!forceRefresh && cached && dependencies.epochNow() - cached.fetchedAt < cacheTtlMs()) return publicStatus(cached);

    const record = await dependencies.read(userId);
    if (!record) return { connected: false, status: "disconnected", modelIds: [], balance: null };
    if (record.status !== "active") return { connected: record.status !== "disconnected", status: record.status, keyFingerprint: record.keyFingerprint, modelIds: [], balance: null };
    try {
      const connection = await verifyLoaded(userId, record, decryptActiveRecord(userId, record), false);
      return { connected: true, status: "active", keyFingerprint: connection.fingerprint, modelIds: connection.modelIds, balance: connection.balance };
    } catch (error) {
      if (error instanceof PersistenceError && (error.code === "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" || error.code === "ORBIO_PROVIDER_UNAVAILABLE" || error.code === "ORBIO_NOT_CONFIGURED")) throw error;
      return { connected: true, status: "invalid", keyFingerprint: record.keyFingerprint, modelIds: [], balance: null };
    }
  }

  async function balance(userId: string, forceRefresh = false): Promise<OrbioBalance | null> {
    const cached = metadataCache.get(userId);
    if (!forceRefresh && cached?.balanceFetchedAt !== undefined && dependencies.epochNow() - cached.balanceFetchedAt < cacheTtlMs()) return cached.balance;
    const credential = await loadCredentialForInference(userId);
    const value = await dependencies.balance(credential.apiKey);
    const fetchedAt = dependencies.epochNow();
    metadataCache.set(userId, {
      connected: true,
      status: "active",
      keyFingerprint: credential.fingerprint,
      modelIds: cached?.modelIds ?? [],
      balance: value,
      fetchedAt: cached?.fetchedAt ?? fetchedAt,
      balanceFetchedAt: fetchedAt,
    });
    return value;
  }

  async function disconnect(userId: string): Promise<void> {
    metadataCache.delete(userId);
    await dependencies.remove(userId);
  }

  return { connect, loadCredentialForInference, verifyConnection, markInvalid, status, balance, disconnect };
}

const service = createOrbioConnectionService();

export const connectOrbioConnection = service.connect;
export const loadOrbioCredentialForInference = service.loadCredentialForInference;
export const verifyOrbioConnection = service.verifyConnection;
export const markOrbioConnectionInvalid = service.markInvalid;
export const getOrbioConnectionStatus = service.status;
export const getOrbioBalanceForUser = service.balance;
export const disconnectOrbioConnection = service.disconnect;
