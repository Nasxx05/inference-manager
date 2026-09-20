/**
 * Generic OpenAI-compatible chat adapter.
 *
 * This is the ONLY place in the codebase that talks to the provider, and the
 * ONLY place that builds a request URL. Nothing here knows which model, which
 * provider, or which endpoint is in use — all of that comes from the
 * environment at call time. Changing AGENTFUND_AI_MODEL is sufficient to
 * switch models; changing AGENTFUND_AI_BASE_URL is sufficient to switch
 * providers.
 *
 * Deliberately no model-specific business logic. Where a model needs a special
 * parameter, it is supplied through `getCompatibleRequestOptions()` and nowhere
 * else, so no other module can grow a dependency on a particular model.
 */

import { AiError, classifyStatus, newRequestId, toAiError } from "./errors";
import { aiApiKey, aiBaseUrl, aiModel, aiTimeoutMs, missingConfig } from "./env";

/** One text part of a multimodal user message. */
export interface TextPart {
  type: "text";
  text: string;
}

/**
 * One image part, in the OpenAI-compatible `image_url` shape.
 *
 * A data URL is used rather than a bare URL because the reference image is
 * uploaded to Promgent, not hosted anywhere the provider could fetch. Passing
 * an http URL would give the model no actual visual access.
 */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type MessageContentPart = TextPart | ImagePart;

/**
 * Message content: plain text, or an array of parts when images are included.
 *
 * The string form is the default and is what every existing call uses, so the
 * text-only path is completely unchanged. Only the reference analyzer sends
 * the array form.
 */
export type MessageContent = string | MessageContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent;
}

/** Which part of the flow a call belongs to. Logged, never sent to the provider. */
export type AiStage =
  | "combined-analysis-and-prompt"
  | "task-analysis"
  | "prompt-generation"
  | "reference-analysis"
  | "health-test"
  | "model-list";

/** True when this message carries image content. */
export function hasImageContent(message: ChatMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some((part) => part.type === "image_url");
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Output cap. Required, so no call can run unbounded. */
  maxTokens: number;
  temperature?: number;
  /**
   * Ask for a JSON object when the caller needs structured output. Sent only
   * when explicitly requested: not every model supports the parameter, and
   * sending it blindly makes an otherwise working model fail.
   */
  jsonMode?: boolean;
  /** Overrides the configured model. Used only by the model-availability probe. */
  model?: string;
  /** Stage name for timing logs, so a slow half is identifiable. */
  stage: AiStage;
  /** Correlates every stage belonging to one user request. */
  requestId?: string;
}

export interface ChatResult {
  content: string;
  finishReason?: string | null;
  model: string;
  requestId: string;
  durationMs: number;
  /** Provider-reported generation time, when the provider supplies it. */
  providerDurationMs?: number;
  /** How many times the request was actually sent: 1, or 2 after one retry. */
  attemptCount: number;
}

const CHAT_PATH = "/chat/completions";

/**
 * Builds the chat endpoint from the configured base, exactly once.
 *
 * The base URL represents the API root, not the endpoint, so the path is
 * appended here. If an operator pastes a full URL that already ends in
 * `/chat/completions`, the suffix is recognised and not appended a second time,
 * which would otherwise produce `.../chat/completions/chat/completions`.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new AiError("BACKEND_NOT_CONFIGURED", "AGENTFUND_AI_BASE_URL is not set.");
  const lower = base.toLowerCase();
  if (lower.endsWith(CHAT_PATH) || lower.endsWith("/completions")) return base;
  return `${base}${CHAT_PATH}`;
}

/**
 * Model-specific request options, isolated so the rest of the system stays
 * model-independent.
 *
 * Returns an empty object unless a parameter is genuinely known to be
 * supported. Every entry must be optional to the provider: adding a parameter
 * a model rejects turns a working model into a 400.
 *
 * Recognised capabilities are inferred from the model id, not hard-coded to one
 * vendor. If nothing is known, `{}` is returned and the request stays generic.
 */
export function getCompatibleRequestOptions(model: string): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const id = model.toLowerCase();

  // Reasoning models bill thinking tokens against the same output cap, so they
  // need headroom that a non-reasoning model does not. Without this they spend
  // the whole budget reasoning and return null content.
  if (/(^|\/)(o\d|gpt-5|hy4|glm|deepseek-r|qvq|qwq)/.test(id) || /reason|thinking/.test(id)) {
    options.reasoning_effort = "low";
  }
  return options;
}

/** Capabilities the rest of the code may adapt to. Never required. */
export function getModelCapabilities(model: string): {
  reasoning: boolean;
  jsonMode: boolean;
} {
  const id = model.toLowerCase();
  const reasoning = Object.keys(getCompatibleRequestOptions(model)).length > 0;
  // Very small or clearly non-instruct models are the only ones we assume
  // cannot honour JSON mode. Everything else is given the chance.
  return { reasoning, jsonMode: !/(^|\/)(davinci|babbage|ada|curie)/.test(id) };
}

interface LogFields {
  requestId: string;
  timestamp: string;
  stage: AiStage;
  endpoint: string;
  model: string;
  durationMs: number;
  success: boolean;
  status?: number;
  errorCode?: string;
  attempt?: number;
}

/**
 * One structured line per call.
 *
 * The `stage` field is what makes a slow request diagnosable: it separates time
 * spent in task-analysis from time spent in prompt-generation, so the logs say
 * which half is slow rather than only reporting a total.
 *
 * Records what makes a Render log useful — id, time, stage, endpoint, model,
 * duration, outcome — and deliberately nothing else: no key, no Authorization
 * header, no prompt body, no user content.
 */
function logCall(fields: LogFields): void {
  const line = [
    `ts=${fields.timestamp}`,
    `requestId=${fields.requestId}`,
    `stage=${fields.stage}`,
    `endpoint=${fields.endpoint}`,
    `model=${fields.model}`,
    `durationMs=${fields.durationMs}`,
    `success=${fields.success}`,
    `status=${fields.status ?? "-"}`,
    `errorCode=${fields.errorCode ?? "-"}`,
    `attempt=${fields.attempt ?? 1}`,
  ].join(" ");
  console.log(`[ai] ${line}`);
}

/** Reads config once per call. Never returns a key value to a caller that logs. */
function config() {
  const missing = missingConfig();
  if (missing.length) {
    throw new AiError(
      "BACKEND_NOT_CONFIGURED",
      `Missing required environment: ${missing.join(", ")}.`,
    );
  }
  return {
    baseUrl: aiBaseUrl(),
    apiKey: aiApiKey() as string,
    model: aiModel() as string,
    timeoutMs: aiTimeoutMs(),
  };
}

/**
 * One attempt. Bounded by `timeoutMs` via AbortController, so a hung provider
 * can never hold a request open indefinitely.
 */
async function attemptOnce(request: ChatRequest, attempt: number): Promise<ChatResult> {
  const { baseUrl, apiKey, model, timeoutMs } = config();
  const useModel = request.model ?? model;
  const url = chatCompletionsUrl(baseUrl);
  const started = Date.now();
  // One id for the whole logical call, including its retry, so a failure and
  // the attempt that preceded it are correlatable in the logs.
  const requestId = request.requestId ?? newRequestId();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body: Record<string, unknown> = {
    model: useModel,
    messages: request.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature ?? 0.2,
    ...getCompatibleRequestOptions(useModel),
    // JSON mode only when the caller needs it and the model plausibly supports it.
    ...(request.jsonMode && getModelCapabilities(useModel).jsonMode
      ? { response_format: { type: "json_object" } }
      : {}),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const durationMs = Date.now() - started;

    if (!response.ok) {
      const error = classifyStatus(response.status, requestId);
      logCall({
        requestId,
        timestamp: new Date().toISOString(),
        stage: request.stage,
        endpoint: url,
        model: useModel,
        durationMs,
        success: false,
        status: response.status,
        errorCode: error.code,
        attempt,
      });
      throw error;
    }

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null };
      }>;
      /** Present on some OpenAI-compatible providers. Reporting only. */
      timings?: Record<string, number>;
    };
    const providerDurationMs =
      typeof payload.timings?.["total_seconds"] === "number"
        ? Math.round(payload.timings["total_seconds"] * 1000)
        : undefined;
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;

    if (!content) {
      const error = new AiError("AI_INVALID_RESPONSE", "The AI provider returned no content.", {
        retryable: true,
        requestId,
      });
      logCall({
        requestId,
        timestamp: new Date().toISOString(),
        stage: request.stage,
        endpoint: url,
        model: useModel,
        durationMs,
        success: false,
        status: response.status,
        errorCode: error.code,
        attempt,
      });
      throw error;
    }

    logCall({
      requestId,
      timestamp: new Date().toISOString(),
      stage: request.stage,
      endpoint: url,
      model: payload.model ?? useModel,
      durationMs,
      success: true,
      status: response.status,
      attempt,
    });

    return {
      content,
      finishReason: choice?.finish_reason,
      model: payload.model ?? useModel,
      requestId,
      durationMs,
      providerDurationMs,
      attemptCount: attempt,
    };
  } catch (error) {
    if (error instanceof AiError) throw error;
    // Abort means the deadline passed; anything else is a transport fault.
    const ai = toAiError(error, requestId);
    logCall({
      requestId,
      timestamp: new Date().toISOString(),
      stage: request.stage,
      endpoint: url,
      model: useModel,
      durationMs: Date.now() - started,
      success: false,
      errorCode: ai.code,
      attempt,
    });
    throw ai;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a chat request, retrying at most once and only for transient failures.
 *
 * A second attempt is made for timeouts, 429, 502/503/504 and temporary network
 * faults. A bad key, an unknown model or a malformed request fails immediately:
 * retrying can only delay the same answer. There is no unlimited retry loop,
 * and a retry is never triggered by a failure that cannot plausibly improve.
 */
export async function chat(request: ChatRequest): Promise<ChatResult> {
  try {
    return await attemptOnce(request, 1);
  } catch (error) {
    const ai = toAiError(error, request.requestId);
    if (!ai.retryable) throw ai;
    await wait(1200);
    return await attemptOnce(request, 2);
  }
}

/** Reads the provider's model list, if it exposes one. */
export async function listModels(): Promise<
  { ok: true; ids: string[] } | { ok: false; error: AiError }
> {
  let baseUrl: string;
  let apiKey: string;
  try {
    const cfg = config();
    baseUrl = cfg.baseUrl;
    apiKey = cfg.apiKey;
  } catch (error) {
    return { ok: false, error: toAiError(error) };
  }

  const url = `${baseUrl.trim().replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  // A model list is metadata, not generation: it should never be allowed to
  // consume the full generation timeout and stall a health check.
  const timer = setTimeout(() => controller.abort(), Math.min(aiTimeoutMs(), 10000));

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: classifyStatus(response.status) };

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const ids = (payload.data ?? [])
      .map((entry) => String(entry?.id ?? "").trim())
      .filter(Boolean);
    return { ok: true, ids };
  } catch (error) {
    return { ok: false, error: toAiError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records one latency line per planning request.
 *
 * Split into LLM, parse and local time deliberately: a slow request is only
 * fixable once it is clear whether the time went to the provider, to parsing
 * the response, or to Promgent's own calculations.
 */
export function logTiming(fields: {
  requestId: string;
  stage: AiStage;
  model: string;
  totalDurationMs: number;
  llmDurationMs: number;
  providerDurationMs?: number;
  responseParseDurationMs: number;
  localCalculationDurationMs: number;
  success: boolean;
  retryCount: number;
  errorCode?: string;
}): void {
  const line = [
    `ts=${new Date().toISOString()}`,
    `requestId=${fields.requestId}`,
    `stage=${fields.stage}`,
    `model=${fields.model}`,
    `totalDurationMs=${fields.totalDurationMs}`,
    `llmDurationMs=${fields.llmDurationMs}`,
    `providerDurationMs=${fields.providerDurationMs ?? "-"}`,
    `parseDurationMs=${fields.responseParseDurationMs}`,
    `localDurationMs=${fields.localCalculationDurationMs}`,
    `success=${fields.success}`,
    `retryCount=${fields.retryCount}`,
    `errorCode=${fields.errorCode ?? "-"}`,
  ].join(" ");
  console.log(`[timing] ${line}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
