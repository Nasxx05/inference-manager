/**
 * Diagnostics for the AI provider connection.
 *
 * Two levels, deliberately separate:
 *
 *   /health      the Render backend itself. Must never depend on the provider,
 *                or a provider outage would make Render kill a healthy instance.
 *   /health/ai   the provider connection, checked end to end.
 *
 * The AI check follows the diagnostic order that makes a failure interpretable:
 * key present → base URL present → model present → model exists → provider
 * reachable → a trivial request succeeds. Each step can fail independently, so
 * a bad key is never reported as "unreachable".
 *
 * Nothing here returns a key, an Authorization header, a request body or any
 * user content.
 */

import { chat, listModels } from "./chatClient";
import { AI_TEST_EXPECTED, AiError, toAiError } from "./errors";
import {
  aiApiKey,
  aiBaseUrl,
  aiFallbackModel,
  aiMaxTokens,
  aiModel,
  aiProviderConfigured,
  aiTimeoutMs,
  missingConfig,
} from "./env";

export interface BackendHealth {
  status: "ok";
  providerConfigured: boolean;
  /** Presence only. A key that is set but empty reads as absent. */
  apiKeyPresent: boolean;
  baseUrlPresent: boolean;
  modelConfigured: boolean;
  model: string | null;
  maxTokens: number;
  timeoutMs: number;
  missing: string[];
}

export type ModelCheck =
  | { state: "verified" }
  | { state: "unavailable"; detail: string }
  | { state: "unknown"; detail: string };

export interface AiHealth {
  status: "ok" | "degraded";
  providerConfigured: boolean;
  providerReachable: boolean;
  modelConfigured: boolean;
  modelAvailable: boolean;
  simpleRequestSucceeded: boolean;
  model: string | null;
  modelCheck: ModelCheck;
  fallbackModel: string | null;
  error: { code: string; message: string; requestId: string } | null;
}

/** Checks the backend's own configuration. Never contacts the provider. */
export function backendHealth(): BackendHealth {
  return {
    status: "ok",
    providerConfigured: aiProviderConfigured(),
    // Presence only. The value itself is never read out, logged or returned.
    apiKeyPresent: Boolean(aiApiKey()),
    baseUrlPresent: Boolean(aiBaseUrl()),
    modelConfigured: Boolean(aiModel()),
    model: aiModel() ?? null,
    maxTokens: aiMaxTokens(),
    timeoutMs: aiTimeoutMs(),
    missing: missingConfig(),
  };
}

/**
 * Confirms the configured model exists.
 *
 * Uses the provider's model list when it exposes one. "unknown" is returned
 * when the provider does not expose a list or rejects the call — that is not
 * the same as "available", and it is never silently treated as a pass.
 */
export async function checkModelAvailable(): Promise<ModelCheck> {
  const model = aiModel();
  if (!model) return { state: "unavailable", detail: "AGENTFUND_AI_MODEL is not set." };

  const result = await listModels();
  if (!result.ok) {
    return {
      state: "unknown",
      detail: `Could not read the model list: ${result.error.code}. The model was not verified.`,
    };
  }
  if (result.ids.length === 0) {
    return { state: "unknown", detail: "The provider returned an empty model list." };
  }
  if (result.ids.includes(model)) return { state: "verified" };

  const fallback = aiFallbackModel();
  const detail = fallback
    ? `The provider does not list "${model}". AGENTFUND_AI_FALLBACK_MODEL is set to "${fallback}".`
    : `The provider does not list "${model}".`;
  return { state: "unavailable", detail };
}

/**
 * Sends a trivial prompt and expects an exact echo.
 *
 * This isolates provider problems from prompt-generation problems: if this
 * fails, the connection or credentials are at fault, not the planner.
 */
export async function simpleAiTest(): Promise<{
  ok: boolean;
  requestId?: string;
  durationMs?: number;
  model?: string;
  error?: { code: string; message: string; requestId: string };
  raw?: string;
}> {
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content: "Reply with the exact string you are asked for. Nothing else.",
        },
        { role: "user", content: `Return exactly:\n${AI_TEST_EXPECTED}` },
      ],
      maxTokens: Math.min(aiMaxTokens(), 64),
      temperature: 0,
    });

    // Trim and compare case-insensitively: a model that adds a trailing newline
    // or quotes is still correctly connected. Anything else is not an echo.
    const cleaned = result.content.trim().replace(/^["'`]|["'`]$/g, "").trim();
    const ok = cleaned.toUpperCase() === AI_TEST_EXPECTED;

    return {
      ok,
      requestId: result.requestId,
      durationMs: result.durationMs,
      model: result.model,
      ...(ok ? {} : { error: {
        code: "AI_INVALID_RESPONSE",
        message: `The model did not return ${AI_TEST_EXPECTED}.`,
        requestId: result.requestId,
      }, raw: cleaned.slice(0, 80) }),
    };
  } catch (error) {
    const ai = toAiError(error);
    return {
      ok: false,
      error: { code: ai.code, message: ai.message, requestId: ai.requestId },
    };
  }
}

/** Full provider diagnostic. Never throws; reports what it found. */
export async function aiHealth(): Promise<AiHealth> {
  const base: AiHealth = {
    status: "degraded",
    providerConfigured: aiProviderConfigured(),
    providerReachable: false,
    modelConfigured: Boolean(aiModel()),
    modelAvailable: false,
    simpleRequestSucceeded: false,
    model: aiModel() ?? null,
    modelCheck: { state: "unknown", detail: "Not checked." },
    fallbackModel: aiFallbackModel() ?? null,
    error: null,
  };

  if (!base.providerConfigured) {
    const error = new AiError(
      "BACKEND_NOT_CONFIGURED",
      `Missing required environment: ${missingConfig().join(", ")}.`,
    );
    return { ...base, error: { code: error.code, message: error.message, requestId: error.requestId } };
  }

  const modelCheck = await checkModelAvailable();
  base.modelCheck = modelCheck;

  if (modelCheck.state === "unavailable") {
    const error = new AiError("AI_MODEL_UNAVAILABLE", modelCheck.detail);
    return {
      ...base,
      error: { code: error.code, message: error.message, requestId: error.requestId },
    };
  }

  // The echo test is the real proof: it exercises auth, routing and generation.
  const test = await simpleAiTest();
  base.simpleRequestSucceeded = test.ok;
  base.providerReachable = !test.error || test.error.code !== "AI_PROVIDER_UNREACHABLE" && test.error.code !== "AI_TIMEOUT";

  if (test.ok) {
    base.modelAvailable = modelCheck.state === "verified";
    base.status = modelCheck.state === "verified" ? "ok" : "degraded";
    return base;
  }

  const error = test.error ?? {
    code: "AI_UNKNOWN_ERROR",
    message: "The connectivity test did not return a result.",
    requestId: "req_unknown",
  };
  return { ...base, error };
}