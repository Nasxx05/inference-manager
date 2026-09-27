import { PersistenceError } from "./persistence";

function baseUrl(): string {
  return String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
}

/** Verifies a user-supplied Orbio key without ever logging or returning it. */
export interface OrbioBalance {
  available: number;
  total?: number;
  used?: number;
  currency: string;
  source: "credits" | "key";
}

export async function verifyOrbioKey(apiKey: string): Promise<{ modelCount?: number; modelIds: string[] }> {
  const base = baseUrl();
  if (!base) throw new PersistenceError("ORBIO_NOT_CONFIGURED", "ORBIO_BASE_URL is not configured.");
  if (!apiKey.trim()) throw new PersistenceError("ORBIO_KEY_INVALID", "Enter an Orbio API key.", 400);

  let response: Response;
  try {
    response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
    });
  } catch {
    throw new PersistenceError("ORBIO_REQUEST_FAILED", "Orbio could not be reached.", 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new PersistenceError("ORBIO_KEY_INVALID", "Orbio rejected that API key.", 400);
  }
  if (!response.ok) {
    throw new PersistenceError("ORBIO_REQUEST_FAILED", "Orbio could not verify the connection.", 502);
  }
  const payload = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
  const modelIds = Array.isArray(payload?.data)
    ? payload.data.flatMap((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [String((item as { id: string }).id)] : [])
    : [];
  return { modelCount: modelIds.length || undefined, modelIds };
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseBalance(payload: unknown, source: OrbioBalance["source"]): OrbioBalance | null {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : root;
  const nestedBalance = data.balance && typeof data.balance === "object" ? data.balance as Record<string, unknown> : {};
  const total = numberValue(data.total_credits ?? data.totalCredits ?? data.limit ?? data.limit_usd ?? nestedBalance.total ?? nestedBalance.total_credits);
  const used = numberValue(data.total_usage ?? data.totalUsage ?? data.usage ?? data.used ?? data.spend ?? nestedBalance.used ?? nestedBalance.total_usage);
  const direct = numberValue(data.available ?? data.available_credits ?? data.availableUsd ?? nestedBalance.available ?? nestedBalance.available_credits ?? nestedBalance.available_usd);
  const available = direct ?? (total !== undefined && used !== undefined ? total - used : total);
  if (available === undefined) return null;
  return {
    available: Math.max(0, Number(available.toFixed(6))),
    ...(total !== undefined ? { total: Math.max(0, Number(total.toFixed(6))) } : {}),
    ...(used !== undefined ? { used: Math.max(0, Number(used.toFixed(6))) } : {}),
    currency: String(data.currency ?? nestedBalance.currency ?? "CREDIT"),
    source,
  };
}

/**
 * Reads a provider balance without charging an inference request. Orbio's
 * OpenAI-compatible gateway may expose either an OpenRouter-compatible
 * credits/key endpoint; ORBIO_BALANCE_URL can override that contract.
 */
export async function getOrbioBalance(apiKey: string): Promise<OrbioBalance | null> {
  const base = baseUrl();
  if (!base || !apiKey.trim()) return null;
  const configured = String(process.env.ORBIO_BALANCE_URL ?? "").trim();
  const candidates = configured
    ? [{ url: configured, source: "credits" as const }]
    : [
      { url: `${base}/credits`, source: "credits" as const },
      { url: `${base}/key`, source: "key" as const },
    ];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url, { headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" } });
      if (!response.ok) continue;
      const balance = parseBalance(await response.json().catch(() => null), candidate.source);
      if (balance) return balance;
    } catch {
      // Balance is supplementary; an unavailable balance endpoint must not
      // make a valid Orbio connection unusable.
    }
  }
  return null;
}
