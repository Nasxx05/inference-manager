import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionError, transcribeAudio, transcriptionFormat } from "../server/src/transcription";

const originalEnv = { ...process.env };

function providerResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("Expected transcription to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptionError);
    return (error as TranscriptionError).code;
  }
}

describe("voice transcription transport", () => {
  beforeEach(() => {
    process.env.TRANSCRIPTION_URL = "https://provider.example/audio/transcriptions";
    process.env.TRANSCRIPTION_API_KEY = "secret-api-key";
    process.env.TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
    process.env.TRANSCRIPTION_REQUEST_MODE = "json_base64";
    process.env.TRANSCRIPTION_TIMEOUT_MS = "60000";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it.each([
    ["audio/webm", "webm"],
    ["audio/webm;codecs=opus", "webm"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["audio/wav", "wav"],
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/aac", "aac"],
  ])("maps %s to %s", (mimeType, expected) => {
    expect(transcriptionFormat(mimeType)).toBe(expected);
  });

  it("rejects unsupported MIME types instead of guessing", () => {
    expect(() => transcriptionFormat("audio/unknown")).toThrowError(expect.objectContaining({ code: "TRANSCRIPTION_FORMAT_UNSUPPORTED" }));
  });

  it("sends raw base64 JSON and keeps the API key only in Authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse(200, { text: "hello" }));
    const buffer = Buffer.from("unique audio bytes");
    await expect(transcribeAudio({ buffer, mimeType: "audio/webm;codecs=opus" })).resolves.toBe("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    const headers = options?.headers as Record<string, string>;
    const body = String(options?.body);
    const parsed = JSON.parse(body);
    expect(url).toBe(process.env.TRANSCRIPTION_URL);
    expect(headers).toEqual({ Authorization: "Bearer secret-api-key", "Content-Type": "application/json" });
    expect(parsed.input_audio).toEqual({ data: buffer.toString("base64"), format: "webm" });
    expect(body).not.toContain("data:audio/webm;base64,");
    expect(body).not.toContain("secret-api-key");
  });

  it("never logs the API key or encoded audio", async () => {
    const buffer = Buffer.from("do-not-log-this-audio-payload");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse(400, { error: { code: "bad_audio", message: `Invalid audio format ${process.env.TRANSCRIPTION_API_KEY} ${buffer.toString("base64")}` } }));
    await errorCode(transcribeAudio({ buffer, mimeType: "audio/webm" }));
    const logs = vi.mocked(console.info).mock.calls.flat().join(" ");
    expect(logs).not.toContain("secret-api-key");
    expect(logs).not.toContain(buffer.toString("base64"));
    expect(logs).not.toContain(buffer.toString());
  });

  it.each([
    [401, { error: { message: "bad key" } }, "TRANSCRIPTION_AUTH_FAILED"],
    [403, { error: { message: "forbidden" } }, "TRANSCRIPTION_AUTH_FAILED"],
    [404, { message: "not found" }, "TRANSCRIPTION_ENDPOINT_UNAVAILABLE"],
    [400, { error: { code: "model_not_found", message: "Model unsupported" } }, "TRANSCRIPTION_MODEL_UNAVAILABLE"],
    [400, { error: { code: "invalid_audio", message: "Unsupported input format" } }, "TRANSCRIPTION_AUDIO_REJECTED"],
    [429, { error: { message: "slow down" } }, "TRANSCRIPTION_RATE_LIMITED"],
    [500, { error: { message: "failed" } }, "TRANSCRIPTION_PROVIDER_UNAVAILABLE"],
    [503, { error: { message: "failed" } }, "TRANSCRIPTION_PROVIDER_UNAVAILABLE"],
  ])("normalizes HTTP %i as %s", async (status, payload, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse(status, payload));
    await expect(errorCode(transcribeAudio({ buffer: Buffer.from("audio"), mimeType: "audio/ogg" }))).resolves.toBe(expected);
  });

  it("aborts a request at the configured timeout", async () => {
    vi.useFakeTimers();
    process.env.TRANSCRIPTION_TIMEOUT_MS = "25";
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const result = errorCode(transcribeAudio({ buffer: Buffer.from("audio"), mimeType: "audio/wav" }));
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe("TRANSCRIPTION_TIMEOUT");
  });

  it("returns payload.text after one successful request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse(200, { text: "  editable transcript  " }));
    await expect(transcribeAudio({ buffer: Buffer.from("audio"), mimeType: "audio/mpeg" })).resolves.toBe("editable transcript");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses multipart only when explicitly configured", async () => {
    process.env.TRANSCRIPTION_REQUEST_MODE = "multipart";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse(200, { text: "multipart transcript" }));
    await transcribeAudio({ buffer: Buffer.from("audio"), mimeType: "audio/webm" });

    const options = fetchMock.mock.calls[0][1];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(options?.body).toBeInstanceOf(FormData);
    expect((options?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((options?.body as FormData).get("model")).toBe("openai/whisper-large-v3-turbo");
    expect((options?.body as FormData).get("file")).toBeInstanceOf(Blob);
  });

  it("uses an audio-capable chat completion when explicitly configured", async () => {
    process.env.TRANSCRIPTION_REQUEST_MODE = "chat_completions";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse(200, {
      choices: [{ message: { content: "spoken through chat" } }],
    }));
    const buffer = Buffer.from("audio");

    await expect(transcribeAudio({ buffer, mimeType: "audio/webm" })).resolves.toBe("spoken through chat");

    const options = fetchMock.mock.calls[0][1];
    const payload = JSON.parse(String(options?.body));
    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "Transcribe the spoken words exactly. Return only the transcript." },
      { type: "input_audio", input_audio: { data: buffer.toString("base64"), format: "webm" } },
    ]);
    expect(payload.response_format).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry with another transport after provider rejection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse(415, { message: "wrong transport" }));
    await expect(errorCode(transcribeAudio({ buffer: Buffer.from("audio"), mimeType: "audio/webm" }))).resolves.toBe("TRANSCRIPTION_PROVIDER_REJECTED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires explicit transcription configuration", async () => {
    delete process.env.TRANSCRIPTION_URL;
    await expect(errorCode(transcribeAudio({ buffer: Buffer.from("audio"), mimeType: "audio/webm" }))).resolves.toBe("TRANSCRIPTION_NOT_CONFIGURED");
  });
});
