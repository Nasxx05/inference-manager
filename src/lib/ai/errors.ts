/**
 * The single error vocabulary for the AI layer.
 *
 * Every failure that reaches the HTTP boundary is converted into an
 * `AiError` and then into `{ success: false, error: { code, message, requestId } }`.
 * Raw provider text is never forwarded: it routinely contains request bodies,
 * model internals and identifiers the user cannot act on, and it changes
 * without notice between providers.
 */

export const AI_ERROR_CODES = [
  "BACKEND_NOT_CONFIGURED",
  "AI_PROVIDER_UNREACHABLE",
  "AI_AUTH_FAILED",
  "AI_MODEL_UNAVAILABLE",
  "AI_RATE_LIMITED",
  "AI_TIMEOUT",
  "AI_INVALID_RESPONSE",
  "AI_VALIDATION_FAILED",
  "AI_UNKNOWN_ERROR",
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** The literal the connectivity test asks the model to echo back. */
export const AI_TEST_EXPECTED = "AGENTFUND_TEST_OK";

export class AiError extends Error {
  readonly code: AiErrorCode;

  /**
   * False for failures that will not improve on a retry: a bad key, an unknown
   * model, a malformed request, a missing configuration. True for 429, 502,
   * 503, a timeout, or a temporary network fault.
   */
  readonly retryable: boolean;

  /** HTTP status from the provider, when the failure came from a response. */
  readonly status?: number;

  /** Correlates the error with the server-side log line for the same call. */
  readonly requestId: string;

  constructor(
    code: AiErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.requestId = options.requestId ?? newRequestId();
  }
}

/** Short, unique, log-friendly id: `req_4f2c9a1b8e`. */
export function newRequestId(): string {
  const bytes = new Uint8Array(5);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `req_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Maps a provider HTTP status onto a code and a retry decision.
 *
 * Only genuinely transient conditions are retried. A 401 is a bad key and a
 * 404 is an unknown model or wrong base URL: retrying either just delays the
 * same answer. 402 (out of credit) is retryable in the sense that it may clear
 * once topped up, but it is not a network fault, so it is reported distinctly.
 */
export function classifyStatus(status: number, requestId?: string): AiError {
  const id = requestId ?? newRequestId();
  switch (status) {
    case 401:
    case 403:
      return new AiError("AI_AUTH_FAILED", "The AI provider rejected the credentials.", {
        retryable: false,
        status,
        requestId: id,
      });
    case 404:
      return new AiError(
        "AI_MODEL_UNAVAILABLE",
        "The AI provider does not recognise the configured model or endpoint.",
        { retryable: false, status, requestId: id },
      );
    case 429:
      return new AiError("AI_RATE_LIMITED", "The AI provider is rate limiting requests.", {
        retryable: true,
        status,
        requestId: id,
      });
    case 408:
    case 409:
    case 502:
    case 503:
    case 504:
      return new AiError("AI_PROVIDER_UNREACHABLE", "The AI provider is temporarily unavailable.", {
        retryable: true,
        status,
        requestId: id,
      });
    case 400:
    case 422:
      return new AiError(
        "AI_VALIDATION_FAILED",
        "The AI provider rejected the request as malformed or unsupported.",
        { retryable: false, status, requestId: id },
      );
    default:
      return new AiError("AI_UNKNOWN_ERROR", `The AI provider returned HTTP ${status}.`, {
        retryable: status >= 500,
        status,
        requestId: id,
      });
  }
}

/**
 * Wraps anything thrown that is not already an `AiError`. Timeouts and network
 * faults are retryable; everything else is not, because we cannot know that a
 * second attempt would behave differently.
 */
export function toAiError(error: unknown, requestId?: string): AiError {
  if (error instanceof AiError) return error;
  const id = requestId ?? newRequestId();

  if (error instanceof Error && error.name === "AbortError") {
    return new AiError("AI_TIMEOUT", "The AI provider took too long to respond.", {
      retryable: true,
      requestId: id,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const networkish =
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network");

  return new AiError(
    networkish ? "AI_PROVIDER_UNREACHABLE" : "AI_UNKNOWN_ERROR",
    networkish ? "The AI provider could not be reached." : message,
    { retryable: networkish, requestId: id },
  );
}