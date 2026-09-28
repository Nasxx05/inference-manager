import { randomUUID } from "node:crypto";

type TranscriptionRequestMode = "json_base64" | "multipart";
type ProviderPayload = {
  text?: unknown;
  transcript?: unknown;
  message?: unknown;
  error?: { message?: unknown; code?: unknown } | unknown;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PROVIDER_MESSAGE_LENGTH = 500;

export class TranscriptionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;

  constructor(code: string, message: string, status = 502, requestId = newTranscriptionRequestId()) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

function newTranscriptionRequestId(): string {
  return `tr_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function transcriptionFormat(mimeType: string): string {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  switch (mime) {
    case "audio/webm": return "webm";
    case "audio/ogg": return "ogg";
    case "audio/wav":
    case "audio/x-wav": return "wav";
    case "audio/mpeg":
    case "audio/mp3": return "mp3";
    case "audio/mp4":
    case "audio/m4a": return "m4a";
    case "audio/aac": return "aac";
    case "audio/flac": return "flac";
    default:
      throw new TranscriptionError("TRANSCRIPTION_FORMAT_UNSUPPORTED", "This browser produced an unsupported audio format.", 400);
  }
}

function requestMode(): TranscriptionRequestMode {
  const configured = String(process.env.TRANSCRIPTION_REQUEST_MODE ?? "json_base64").trim().toLowerCase();
  if (configured === "json_base64" || configured === "multipart") return configured;
  throw new TranscriptionError("TRANSCRIPTION_NOT_CONFIGURED", "TRANSCRIPTION_REQUEST_MODE must be json_base64 or multipart.", 503);
}

function timeoutMs(): number {
  const value = Number(process.env.TRANSCRIPTION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

function parsePayload(raw: string): ProviderPayload | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProviderPayload : null;
  } catch {
    return null;
  }
}

function redactLogValue(value: string, sensitiveValues: string[]): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length >= 4) redacted = redacted.split(sensitive).join("[redacted]");
  }
  return redacted.replace(/[A-Za-z0-9+/]{64,}={0,2}/g, "[redacted-base64]");
}

function safeProviderDetails(payload: ProviderPayload | null, sensitiveValues: string[]): { code: string; message: string } {
  const error = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as { message?: unknown; code?: unknown }
    : null;
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : "";
  const candidate = error?.message ?? payload?.message ?? "";
  const message = redactLogValue((typeof candidate === "string" ? candidate : "").replace(/[\r\n\t]+/g, " ").trim(), sensitiveValues).slice(0, MAX_PROVIDER_MESSAGE_LENGTH);
  return { code: redactLogValue(code, sensitiveValues).slice(0, 100), message };
}

function normalizedProviderError(status: number, details: { code: string; message: string }, requestId: string): TranscriptionError {
  if (status === 401 || status === 403) return new TranscriptionError("TRANSCRIPTION_AUTH_FAILED", "The transcription provider rejected the configured API key.", 401, requestId);
  if (status === 404) return new TranscriptionError("TRANSCRIPTION_ENDPOINT_UNAVAILABLE", "The configured provider does not expose the transcription endpoint.", 502, requestId);
  if (status === 429) return new TranscriptionError("TRANSCRIPTION_RATE_LIMITED", "The transcription provider is rate limiting requests. Please wait and try again.", 503, requestId);
  if (status >= 500) return new TranscriptionError("TRANSCRIPTION_PROVIDER_UNAVAILABLE", "The transcription provider is temporarily unavailable.", 503, requestId);

  const providerText = `${details.code} ${details.message}`.toLowerCase();
  const unavailable = /(not[ _-]?found|unsupported|not supported|unavailable|does not exist|unknown|invalid)/;
  if (status === 400 && providerText.includes("model") && unavailable.test(providerText)) {
    return new TranscriptionError("TRANSCRIPTION_MODEL_UNAVAILABLE", "The configured transcription model is not available through this provider.", 400, requestId);
  }
  if (status === 400 && /(input|audio|format|file|media|codec|encoding)/.test(providerText)) {
    return new TranscriptionError("TRANSCRIPTION_AUDIO_REJECTED", "The transcription provider could not read this audio format.", 400, requestId);
  }
  return new TranscriptionError("TRANSCRIPTION_PROVIDER_REJECTED", "The transcription provider rejected the recording.", 502, requestId);
}

function logResult(input: {
  requestId: string;
  status: number | string;
  model: string;
  format: string;
  mimeType: string;
  bytes: number;
  durationMs: number;
  providerCode?: string;
  providerMessage?: string;
}): void {
  const fields = [
    "[transcription]",
    `requestId=${input.requestId}`,
    `status=${input.status}`,
    `model=${input.model}`,
    `format=${input.format}`,
    `mimeType=${input.mimeType.replace(/[\r\n\t]+/g, " ").slice(0, 100)}`,
    `bytes=${input.bytes}`,
    `durationMs=${input.durationMs}`,
  ];
  if (input.providerCode) fields.push(`providerCode=${input.providerCode}`);
  if (input.providerMessage) fields.push(`providerMessage=${input.providerMessage}`);
  console.info(fields.join(" "));
}

/**
 * Provider-neutral transcription seam. The transport is selected once through
 * TRANSCRIPTION_REQUEST_MODE; requests are never automatically retried using a
 * different transport because that could create a second billable request.
 */
export async function transcribeAudio(input: { buffer: Buffer; mimeType: string }): Promise<string> {
  const requestId = newTranscriptionRequestId();
  const url = String(process.env.TRANSCRIPTION_URL ?? "").trim();
  const apiKey = String(process.env.TRANSCRIPTION_API_KEY ?? "").trim();
  const model = String(process.env.TRANSCRIPTION_MODEL ?? "").trim();
  if (!url || !apiKey || !model) throw new TranscriptionError("TRANSCRIPTION_NOT_CONFIGURED", "Voice transcription is not configured.", 503, requestId);
  if (!input.buffer.length) throw new TranscriptionError("TRANSCRIPTION_FAILED", "The recording was empty.", 400, requestId);

  let format: string;
  try {
    format = transcriptionFormat(input.mimeType);
  } catch (error) {
    if (error instanceof TranscriptionError) throw new TranscriptionError(error.code, error.message, error.status, requestId);
    throw error;
  }
  const mode = requestMode();
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: string | FormData;
  if (mode === "json_base64") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ model, input_audio: { data: input.buffer.toString("base64"), format }, response_format: "json" });
  } else {
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(input.buffer)], { type: input.mimeType }), `recording.${format}`);
    form.append("model", model);
    form.append("response_format", "json");
    body = form;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const started = Date.now();
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    raw = await response.text();
  } catch (error) {
    const durationMs = Date.now() - started;
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    logResult({ requestId, status: timedOut ? "timeout" : "network_error", model, format, mimeType: input.mimeType, bytes: input.buffer.length, durationMs });
    if (timedOut) throw new TranscriptionError("TRANSCRIPTION_TIMEOUT", "Voice transcription took too long. Try a shorter recording.", 504, requestId);
    throw new TranscriptionError("TRANSCRIPTION_PROVIDER_UNAVAILABLE", "The transcription provider could not be reached.", 503, requestId);
  } finally {
    clearTimeout(timer);
  }

  const payload = parsePayload(raw);
  const details = safeProviderDetails(payload, [apiKey, input.buffer.toString("base64"), input.buffer.toString("utf8")]);
  logResult({ requestId, status: response.status, model, format, mimeType: input.mimeType, bytes: input.buffer.length, durationMs: Date.now() - started, providerCode: response.ok ? undefined : details.code, providerMessage: response.ok ? undefined : details.message });
  if (!response.ok) throw normalizedProviderError(response.status, details, requestId);

  const text = String(payload?.text ?? payload?.transcript ?? "").trim();
  if (!text) throw new TranscriptionError("TRANSCRIPTION_FAILED", "No speech was detected in the recording.", 502, requestId);
  return text.slice(0, 8000);
}
