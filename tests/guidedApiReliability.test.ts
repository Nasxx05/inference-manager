import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GuidedApiError,
  getSession,
  sendInterview,
  transcribeAudio,
} from "@/lib/guidedApi";

afterEach(() => vi.unstubAllGlobals());

describe("guided API reliability", () => {
  it("treats an anonymous session as a successful non-authenticated probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              success: true,
              data: { authenticated: false, user: null },
            }),
            { status: 200 },
          ),
        ),
    );
    await expect(getSession()).resolves.toEqual({
      authenticated: false,
      user: null,
    });
  });
  it("sends the voice transcript message source", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await sendInterview("project", "spoken words", "voice_transcript");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      content: "spoken words",
      source: "voice_transcript",
    });
  });

  it("shows a safe transcription error with its request reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              success: false,
              error: {
                code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
                message: "internal provider detail",
                requestId: "voice-123",
              },
            }),
            { status: 503 },
          ),
        ),
    );
    const error = await transcribeAudio(
      new Blob(["audio"], { type: "audio/webm" }),
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(GuidedApiError);
    expect(error.message).toBe(
      "Voice transcription is temporarily unavailable. Reference: voice-123.",
    );
    expect(error.message).not.toContain("internal provider detail");
  });
});
