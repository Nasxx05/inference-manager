import { aiApiKey, aiBaseUrl } from "@/lib/ai/env";

export class TranscriptionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Provider-neutral transcription seam; raw audio never enters the reasoning
 * prompt. Explicit TRANSCRIPTION_* values remain supported, but the normal
 * path uses the backend's existing internal provider configuration so voice
 * transcription is not charged to the connected user's Orbio key.
 */
export async function transcribeAudio(input: { buffer: Buffer; mimeType: string }): Promise<string> {
  const configuredBase = aiBaseUrl();
  const url = String(process.env.TRANSCRIPTION_URL ?? `${configuredBase}/audio/transcriptions`).trim();
  const apiKey = String(process.env.TRANSCRIPTION_API_KEY ?? aiApiKey() ?? "").trim();
  const model = String(process.env.TRANSCRIPTION_MODEL ?? "whisper-1").trim();
  if (!url || !apiKey) throw new TranscriptionError("TRANSCRIPTION_NOT_CONFIGURED", "Voice transcription is not configured.", 503);
  if (!input.buffer.length) throw new TranscriptionError("TRANSCRIPTION_FAILED", "The recording was empty.", 400);
  if (!model) throw new TranscriptionError("TRANSCRIPTION_NOT_CONFIGURED", "TRANSCRIPTION_MODEL is not configured.", 503);

  const form = new FormData();
  form.append("file", new Blob([input.buffer], { type: input.mimeType || "audio/webm" }), "recording.webm");
  form.append("model", model);
  form.append("response_format", "json");
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  } catch {
    throw new TranscriptionError("TRANSCRIPTION_FAILED", "The transcription service could not be reached.");
  }
  const payload = (await response.json().catch(() => null)) as { text?: unknown; transcript?: unknown } | null;
  if (!response.ok) throw new TranscriptionError("TRANSCRIPTION_FAILED", "The transcription service rejected the recording.");
  const text = String(payload?.text ?? payload?.transcript ?? "").trim();
  if (!text) throw new TranscriptionError("TRANSCRIPTION_FAILED", "No speech was detected in the recording.");
  return text.slice(0, 8000);
}
