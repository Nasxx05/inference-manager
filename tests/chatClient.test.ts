import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "@/lib/ai/chatClient";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("per-request provider credentials", () => {
  it("sends the Guided Project request through the user's key and records usage", async () => {
    process.env.AGENTFUND_AI_API_KEY = "internal-key-that-must-not-be-used";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: "provider/model",
        choices: [{ finish_reason: "stop", message: { content: '{"assistantMessage":"What is the main workflow?"}' } }],
        usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat({
      apiKey: "user-orbio-key",
      baseUrl: "https://orbio.example/v1",
      model: "provider/model",
      messages: [{ role: "user", content: "Continue the interview." }],
      maxTokens: 700,
      stage: "guided-interview",
      retry: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://orbio.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer user-orbio-key");
    expect(JSON.parse(String(init.body)).model).toBe("provider/model");
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 9, totalTokens: 51 });
  });

  it("does not retry a user-funded interview request after a provider failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(chat({
      apiKey: "user-orbio-key",
      baseUrl: "https://orbio.example/v1",
      model: "provider/model",
      messages: [{ role: "user", content: "Continue the interview." }],
      maxTokens: 700,
      stage: "guided-interview",
      retry: false,
    })).rejects.toMatchObject({ code: "AI_PROVIDER_UNREACHABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
