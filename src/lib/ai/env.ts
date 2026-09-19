/**
 * Environment access for the AI provider.
 *
 * Values set in a hosting dashboard frequently arrive with trailing whitespace
 * or a newline. An API key with a trailing newline is a different string to the
 * provider, so it fails authentication as an unknown key (HTTP 401) even though
 * the key is correct. Everything here is trimmed, and a blank value is treated
 * as unset rather than as an empty string.
 *
 * All of this is read at call time, not module load. The backend is a long-lived
 * process, so a constant captured at startup would freeze the value and ignore
 * any change to the environment. Reading per call also lets tests set these
 * variables and have them actually take effect.
 */

/** Trims an env var; a missing or all-whitespace value is treated as unset. */
export function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length ? value : undefined;
}

/** Provider base URL with any trailing slashes removed. Empty when unset. */
export function aiBaseUrl(): string {
  return (readEnv("AI_BASE_URL") ?? "").replace(/\/+$/, "");
}

/** The API key, or undefined when unset or blank. */
export function aiApiKey(): string | undefined {
  return readEnv("AI_API_KEY");
}

/** Model id, falling back to a safe default. */
export function aiModel(): string {
  return readEnv("AI_MODEL") ?? "gpt-4o-mini";
}

/**
 * Positive number from an env var, or `fallback` when missing or not a usable
 * number. Guards against NaN (which JSON.stringify turns into null and the
 * provider rejects) and against non-positive values.
 */
export function aiNumber(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** True when both a key and a base URL are present. Never contacts the provider. */
export function aiProviderConfigured(): boolean {
  return Boolean(aiApiKey() && aiBaseUrl());
}