import { PersistenceError } from "./persistence";

function baseUrl(): string {
  return String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
}

/** Verifies a user-supplied Orbio key without ever logging or returning it. */
export async function verifyOrbioKey(apiKey: string): Promise<{ modelCount?: number }> {
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
  return { modelCount: Array.isArray(payload?.data) ? payload.data.length : undefined };
}
