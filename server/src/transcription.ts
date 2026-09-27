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

/** Provider-neutral transcription seam; raw audio never enters the reasoning prompt. */
export async function transcribeAudio(input: { buffer: Buffer; mimeType: string }): Promise<string> {
  const url = String(process.env.TRANSCRIPTION_URL ?? "").trim();
  const apiKey = String(process.env.TRANSCRIPTION_API_KEY ?? "").trim();
  if (!url || !apiKey) throw new TranscriptionError("TRANSCRIPTION_NOT_CONFIGURED", "Voice transcription is not configured.", 503);
  if (!input.buffer.length) throw new TranscriptionError("TRANSCRIPTION_FAILED", "The recording was empty.", 400);

  const form = new FormData();
  form.append("file", new Blob([input.buffer], { type: input.mimeType || "audio/webm" }), "recording.webm");
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
