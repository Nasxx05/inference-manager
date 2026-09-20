/**
 * Environment access for Promgent's INTERNAL planning model.
 *
 * Two different models are involved in this system and they must never be
 * confused:
 *
 *   AGENTFUND_AI_MODEL  the model that powers Promgent itself (analysis,
 *                       cost planning, prompt compilation). Server-side only.
 *   user's target model  the model the user picked in the UI, which the
 *                       generated prompt is written FOR. Never a secret, and
 *                       never used to make Promgent's own calls.
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

/** Canonical variable names. */
export const ENV = {
  API_KEY: "AGENTFUND_AI_API_KEY",
  BASE_URL: "AGENTFUND_AI_BASE_URL",
  MODEL: "AGENTFUND_AI_MODEL",
  MAX_TOKENS: "AGENTFUND_AI_MAX_TOKENS",
  ANALYSIS_MAX_TOKENS: "AGENTFUND_AI_ANALYSIS_MAX_TOKENS",
  PROMPT_MAX_TOKENS: "AGENTFUND_AI_PROMPT_MAX_TOKENS",
  TIMEOUT_MS: "AGENTFUND_AI_TIMEOUT_MS",
  COMBINED: "AGENTFUND_AI_COMBINED",
  FALLBACK_MODEL: "AGENTFUND_AI_FALLBACK_MODEL",
  ALLOWED_ORIGINS: "ALLOWED_ORIGINS",
  /**
   * Optional separate model for reference (image/website) understanding.
   *
   * Deliberately separate from AGENTFUND_AI_MODEL: the planning model is
   * chosen for analysis and prompt writing, and it may not accept images.
   * Configuring a multimodal model here adds reference understanding WITHOUT
   * touching the existing planning model or the target-model selection system.
   * Unset means image references cannot be analyzed yet.
   */
  MULTIMODAL_MODEL: "AGENTFUND_AI_MULTIMODAL_MODEL",
  REFERENCE_MAX_TOKENS: "AGENTFUND_AI_REFERENCE_MAX_TOKENS",
  REFERENCE_TIMEOUT_MS: "AGENTFUND_AI_REFERENCE_TIMEOUT_MS",
} as const;

/**
 * Pre-rename names.
 *
 * Accepted only where doing so cannot reintroduce a bad value:
 *
 *  - API_KEY / BASE_URL / MODEL are accepted as last-resort fallbacks, per
 *    variable, so an existing deployment keeps working after the rename.
 *  - AI_MAX_TOKENS is deliberately NOT accepted. It was set to 48000 to work
 *    around a reasoning model that spent its whole budget thinking, and that
 *    single oversized cap is exactly what made every call slow. Falling back to
 *    it would silently undo the split budgets below, so the old variable is
 *    ignored and reported instead.
 *  - AI_TIMEOUT_MS is accepted, since a timeout is not a token budget.
 *
 * @deprecated Use the AGENTFUND_AI_* variables.
 */
const LEGACY: Record<string, string> = {
  [ENV.API_KEY]: "AI_API_KEY",
  [ENV.BASE_URL]: "AI_BASE_URL",
  [ENV.MODEL]: "AI_MODEL",
  [ENV.TIMEOUT_MS]: "AI_TIMEOUT_MS",
};

/** Trims an env var; a missing or all-whitespace value is treated as unset. */
export function readEnv(name: string, legacy?: string): string | undefined {
  const value = firstDefined(name, legacy);
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : undefined;
}

/**
 * Resolves a value for one variable, preferring its canonical name.
 *
 * The decision is made per variable, deliberately. Coupling them (e.g. "ignore
 * all legacy names once any canonical name exists") produces two different
 * bugs: a deployment that sets the canonical key and URL but forgets
 * AGENTFUND_AI_MODEL would silently inherit a stale AI_MODEL from an old
 * dashboard entry, and a deployment that adopts only some variables would lose
 * the rest. Per variable, the rule is simply: use the canonical value if it is
 * set, otherwise fall back to the legacy one for that same setting.
 */
function firstDefined(name: string, legacy?: string): string | undefined {
  const primary = process.env[name];
  if (primary !== undefined && primary !== null && String(primary).trim()) {
    return String(primary);
  }
  if (!legacy) return undefined;
  const old = process.env[legacy];
  return old === undefined || old === null ? undefined : String(old);
}

/**
 * Provider API base with any trailing slashes removed. Empty when unset.
 *
 * This is the API *base*, never the final endpoint: the single place that
 * appends `/chat/completions` is `chatCompletionsUrl()` in ./chatClient.
 */
export function aiBaseUrl(): string {
  return (readEnv(ENV.BASE_URL, LEGACY[ENV.BASE_URL]) ?? "").replace(/\/+$/, "");
}

/** The API key, or undefined when unset or blank. Never logged, never returned. */
export function aiApiKey(): string | undefined {
  return readEnv(ENV.API_KEY, LEGACY[ENV.API_KEY]);
}

/**
 * The configured model id, or undefined when unset.
 *
 * There is deliberately no hard-coded default: guessing a model name would
 * make an unconfigured deployment look configured and fail deep inside the
 * provider call. The caller treats "unset" as BACKEND_NOT_CONFIGURED.
 */
export function aiModel(): string | undefined {
  return readEnv(ENV.MODEL, LEGACY[ENV.MODEL]);
}

/**
 * Optional secondary model, used only when the primary is confirmed
 * unavailable. It is never a silent substitution: every use is recorded in the
 * result and the logs.
 */
export function aiFallbackModel(): string | undefined {
  return readEnv(ENV.FALLBACK_MODEL);
}

/**
 * Positive number from an env var, or `fallback` when missing or not a usable
 * number. Guards against NaN (which JSON.stringify turns into null and the
 * provider rejects) and against non-positive values.
 */
export function aiNumber(name: string, fallback: number, legacy?: string): number {
  const raw = readEnv(name, legacy);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Output cap for the COMBINED call, which returns the task analysis and the
 * finished prompt in one response. This is the normal path, so this is the
 * number that governs latency for most requests.
 *
 * 4500 is enough for a compact JSON analysis plus a genuinely detailed prompt
 * without leaving room for the model to pad. Not 48000: that historical cap let
 * a model spend the whole budget on reasoning and come back with nothing.
 */
export function aiCombinedMaxTokens(): number {
  return Math.round(aiNumber(ENV.MAX_TOKENS, 4500));
}

/**
 * Output cap for the task-analysis call, used only on the two-call fallback
 * path. Small on purpose: the analyser returns one compact JSON object and
 * nothing else.
 */
export function aiAnalysisMaxTokens(): number {
  return Math.round(aiNumber(ENV.ANALYSIS_MAX_TOKENS, 1800));
}

/**
 * Output cap for the prompt-writing call, used only on the two-call fallback
 * path. The deliverable is the prompt itself (roughly 500-900 words), so this
 * is larger than the analysis cap but still bounded so the model cannot pad.
 */
export function aiPromptMaxTokens(): number {
  return Math.round(aiNumber(ENV.PROMPT_MAX_TOKENS, 3000));
}

/**
 * Optional multimodal model for reference understanding.
 *
 * Unset means image references cannot be analyzed. Callers must surface that
 * as a real limitation rather than pretending the image was understood.
 */
export function aiMultimodalModel(): string | undefined {
  return readEnv(ENV.MULTIMODAL_MODEL);
}

/** True when a model is configured specifically for reference analysis. */
export function aiMultimodalConfigured(): boolean {
  return Boolean(aiMultimodalModel());
}

/**
 * Output cap for one reference analysis. Small on purpose: the analyzer
 * returns one compact structured object, not prose.
 */
export function aiReferenceMaxTokens(): number {
  return Math.round(aiNumber(ENV.REFERENCE_MAX_TOKENS, 1200));
}

/**
 * Per-attempt budget for reference analysis.
 *
 * Shorter than the planning timeout because reference analysis is one bounded
 * step in a longer request, not the whole request.
 */
export function aiReferenceTimeoutMs(): number {
  return Math.round(aiNumber(ENV.REFERENCE_TIMEOUT_MS, 45000));
}

/**
 * Whether to use the combined single-call path.
 *
 * One call is the default because it halves provider round trips. Set to "0" to
 * force the two-call path for a model that cannot reliably return analysis and
 * prompt together; the fallback also engages automatically when a combined
 * response fails validation.
 */
export function aiCombinedEnabled(): boolean {
  const raw = readEnv(ENV.COMBINED);
  if (raw === undefined) return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

/** Per-attempt request budget. Every call is bounded; nothing waits forever. */
export function aiTimeoutMs(): number {
  return Math.round(aiNumber(ENV.TIMEOUT_MS, 90000, LEGACY[ENV.TIMEOUT_MS]));
}

/** True when key, base URL and model are all present. Never contacts the provider. */
export function aiProviderConfigured(): boolean {
  return Boolean(aiApiKey() && aiBaseUrl() && aiModel());
}

/**
 * Which of the required variables are missing. Used to turn "not configured"
 * into a specific, actionable message instead of a generic failure.
 */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!aiApiKey()) missing.push(ENV.API_KEY);
  if (!aiBaseUrl()) missing.push(ENV.BASE_URL);
  if (!aiModel()) missing.push(ENV.MODEL);
  return missing;
}

/**
 * True when any legacy AI_* name is still supplying a value.
 *
 * Reported at startup so a pending rename is visible rather than silent. It is
 * purely advisory: it never changes which value is used.
 */
export function usingLegacyEnvNames(): boolean {
  return Object.entries(LEGACY).some(([canonical, legacy]) =>
    valueFromLegacyName(canonical, legacy),
  );
}

/**
 * True when the deprecated AI_MAX_TOKENS is still set.
 *
 * It is ignored, but reported: an operator who set it expects it to matter, and
 * silently honouring it would reintroduce one oversized cap for every call.
 * AGENTFUND_AI_MAX_TOKENS is a different variable and is read normally.
 */
export function legacyMaxTokensPresent(): boolean {
  return isSet(process.env["AI_MAX_TOKENS"]);
}

/** True when this one value exists only under its legacy name. */
export function valueFromLegacyName(name: string, legacy?: string): boolean {
  if (!legacy) return false;
  return !isSet(process.env[name]) && isSet(process.env[legacy]);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}