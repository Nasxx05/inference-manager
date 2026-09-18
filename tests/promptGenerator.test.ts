import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findModelOrThrow } from "@/data/models";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import {
  MAX_PROMPT_CHARS,
  PromptGenerationError,
  acceptablePrompt,
  generatePrompt,
  promptProviderConfigured,
} from "@/lib/ai/promptGenerator";
import { parseSelections, toggleSelection } from "@/components/ClarifyingQuestions";
import type { ClarifyingAnswer } from "@/types";

const targetModel = findModelOrThrow("claude-sonnet");
const analysis = heuristicAnalyze("build a tic-tac-toe game");

const answers: ClarifyingAnswer[] = [
  {
    id: "game_mode",
    question: "Should it be single-player or multiplayer?",
    answer: "Single player against the computer",
    answered: true,
  },
  {
    id: "game_rules",
    question: "How should winning, losing and draws be handled?",
    answer: "Detect a win or a draw immediately, announce the result clearly.",
    answered: false,
  },
];

function input() {
  return {
    taskDescription: "build a tic-tac-toe game",
    analysis,
    targetModel,
    optimization: "balanced" as const,
    budget: 10,
    cost: { minimum: 3.62, maximum: 4.61, recommendedMaximum: 4.94 },
    clarifyingAnswers: answers,
  };
}

function stubFetch(response: {
  content?: string | null;
  finish_reason?: string;
  ok?: boolean;
  status?: number;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => ({
      choices: [
        {
          finish_reason: response.finish_reason ?? "stop",
          message: { content: response.content ?? null },
        },
      ],
    }),
  });
}

function validPrompt(): string {
  return [
    "ROLE",
    "Act as a senior engineer.",
    "",
    "OBJECTIVE",
    "Build the game.",
    "",
    "CONTEXT",
    "The requester wants a tic-tac-toe game for the browser.",
    "",
    "REQUIREMENTS",
    "- Implement a 3x3 board with alternating turns.",
    "- Detect a win or a draw immediately and announce it clearly.",
    "",
    "ASSUMED DEFAULTS",
    "- Assume a single-page browser implementation.",
    "",
    "STRUCTURE AND ARCHITECTURE",
    "- Separate board state from rules from rendering.",
    "",
    "SCOPE",
    "- The complete playable game.",
    "",
    "OUT OF SCOPE",
    "- Multiplayer networking.",
    "",
    "PRIORITIES",
    "- Correct rules first.",
    "",
    "EXECUTION STRATEGY",
    "- Build the rules, then the interface.",
    "",
    "CONSTRAINTS",
    "- Keep it focused.",
    "",
    "BUDGET CONSTRAINT",
    "- Stay within the stated budget.",
    "",
    "VALIDATION",
    "- Verify win and draw detection.",
    "",
    "REVISION POLICY",
    "- Use targeted corrections.",
    "",
    "STOPPING CONDITIONS",
    "- Stop when the game is complete.",
    "",
    "OUTPUT FORMAT",
    "- Return the finished code.",
  ].join("\n");
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.AI_API_KEY = "test-key";
  process.env.AI_BASE_URL = "https://example.test/v1";
  process.env.AI_MODEL = "test-model";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("generatePrompt", () => {
  it("reports whether the prompt-writing model is configured", () => {
    expect(promptProviderConfigured()).toBe(true);
    delete process.env.AI_BASE_URL;
    expect(promptProviderConfigured()).toBe(false);
  });

  it("throws when no prompt-writing model is configured, with no fallback", async () => {
    delete process.env.AI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generatePrompt(input())).rejects.toThrow(PromptGenerationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the model-written prompt on a good response", async () => {
    vi.stubGlobal("fetch", stubFetch({ content: validPrompt() }));
    await expect(generatePrompt(input())).resolves.toBe(`${validPrompt()}\n`);
  });

  it("strips markdown code fences from the response", async () => {
    vi.stubGlobal("fetch", stubFetch({ content: "```markdown\n" + validPrompt() + "\n```" }));
    await expect(generatePrompt(input())).resolves.toBe(`${validPrompt()}\n`);
  });

  it("sends a high max_tokens so reasoning cannot starve the content", async () => {
    const fetchMock = stubFetch({ content: validPrompt() });
    vi.stubGlobal("fetch", fetchMock);

    await generatePrompt(input());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(16000);
    expect(body.model).toBe("test-model");
  });

  it("tells the writer which model the prompt is for", async () => {
    const fetchMock = stubFetch({ content: validPrompt() });
    vi.stubGlobal("fetch", fetchMock);

    await generatePrompt(input());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(JSON.stringify(body.messages)).toContain(targetModel.displayName);
  });

  it("marks confirmed answers binding and skipped answers as assumptions", async () => {
    const fetchMock = stubFetch({ content: validPrompt() });
    vi.stubGlobal("fetch", fetchMock);

    await generatePrompt(input());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const text = JSON.stringify(body.messages);
    expect(text).toContain("CONFIRMED (binding)");
    expect(text).toContain("SKIPPED (assume this and restate it)");
    expect(text).toContain("Single player against the computer");
  });

  it("retries once and succeeds when the first attempt is empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ finish_reason: "length", message: { content: null } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: validPrompt() } }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generatePrompt(input())).resolves.toBe(`${validPrompt()}\n`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when a reasoning model runs out of token budget on both attempts", async () => {
    vi.stubGlobal("fetch", stubFetch({ content: null, finish_reason: "length" }));
    await expect(generatePrompt(input())).rejects.toThrow(PromptGenerationError);
  });

  it("throws when the provider errors", async () => {
    vi.stubGlobal("fetch", stubFetch({ ok: false, status: 500, content: validPrompt() }));
    await expect(generatePrompt(input())).rejects.toThrow(PromptGenerationError);
  });

  it("retries a rate limit instead of treating it as a bad configuration", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: validPrompt() } }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generatePrompt(input())).resolves.toBe(`${validPrompt()}\n`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks bad credentials as non-retryable and stops after one attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generatePrompt(input())).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks an out-of-credit account as retryable but records the status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 402 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generatePrompt(input())).rejects.toMatchObject({ status: 402 });
  });

  it("throws when the response has no choices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
    );
    await expect(generatePrompt(input())).rejects.toThrow(PromptGenerationError);
  });

  it("throws when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(generatePrompt(input())).rejects.toThrow(PromptGenerationError);
  });

  it("throws when the model writes prose instead of the required structure", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        content:
          "Sure! Here is a great prompt you can use for building a game. You should definitely " +
          "make sure the game is fun and works well on many devices and that the code is clean " +
          "and readable and tested properly with good documentation and clear naming conventions " +
          "throughout the entire project structure.",
      }),
    );
    await expect(generatePrompt(input())).rejects.toThrow(PromptGenerationError);
  });
});

describe("acceptablePrompt", () => {
  it("accepts a well-formed prompt", () => {
    expect(acceptablePrompt(validPrompt())).toBe(true);
  });

  it("rejects prompts missing mandatory sections", () => {
    expect(acceptablePrompt(validPrompt().replace("BUDGET CONSTRAINT", "COST NOTES"))).toBe(false);
  });

  it("rejects prompts that open with preamble", () => {
    expect(acceptablePrompt(`Here is your prompt:\n\n${validPrompt()}`)).toBe(false);
  });

  it("rejects empty, tiny and oversized prompts", () => {
    expect(acceptablePrompt("")).toBe(false);
    expect(acceptablePrompt("ROLE\nshort")).toBe(false);
    // Padded past the exported ceiling, so this tracks the real limit rather
    // than a duplicate of it.
    const oversized = `${validPrompt()}\n${"x".repeat(MAX_PROMPT_CHARS)}`;
    expect(oversized.length).toBeGreaterThan(MAX_PROMPT_CHARS);
    expect(acceptablePrompt(oversized)).toBe(false);
  });

  it("accepts a long-but-valid prompt below the ceiling", () => {
    const padded = `${validPrompt()}\n${"x".repeat(MAX_PROMPT_CHARS - validPrompt().length - 1)}`;
    expect(padded.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(acceptablePrompt(padded)).toBe(true);
  });
});

describe("multi-select options", () => {
  it("splits a stored answer back into selections", () => {
    expect(parseSelections("Dark mode toggle, Responsive mobile layout")).toEqual([
      "Dark mode toggle",
      "Responsive mobile layout",
    ]);
    expect(parseSelections("")).toEqual([]);
  });

  it("adds a second option instead of replacing the first", () => {
    const next = toggleSelection("Dark mode toggle", "Search or filtering", false);
    expect(parseSelections(next)).toEqual(["Dark mode toggle", "Search or filtering"]);
  });

  it("removes an option when it is toggled off", () => {
    const next = toggleSelection("Dark mode toggle, Search or filtering", "Dark mode toggle", false);
    expect(parseSelections(next)).toEqual(["Search or filtering"]);
  });

  it("keeps typed text alongside picked options", () => {
    const next = toggleSelection("a custom requirement", "Dark mode toggle", false);
    expect(parseSelections(next)).toEqual(["a custom requirement", "Dark mode toggle"]);
  });

  it("replaces the choice on single-select questions", () => {
    const options = ["TypeScript (Node)", "Python", "Go", "Rust"];
    expect(parseSelections(toggleSelection("Python", "Go", true, options))).toEqual(["Go"]);
  });

  it("drops the previous choice when switching on a single-select question", () => {
    const options = ["Python", "Go", "Rust"];
    let value = toggleSelection("", "Python", true, options);
    value = toggleSelection(value, "Go", true, options);
    expect(parseSelections(value)).toEqual(["Go"]);
  });

  it("keeps typed text when switching on a single-select question", () => {
    const options = ["Python", "Go"];
    const value = toggleSelection("Python, must run on Node 22", "Go", true, options);
    expect(parseSelections(value)).toEqual(["Go", "must run on Node 22"]);
  });

  it("clears the choice when the selected single option is toggled off", () => {
    expect(toggleSelection("Go", "Go", true, ["Go", "Python"])).toBe("");
  });

  it("supports picking three options at once", () => {
    let value = "";
    value = toggleSelection(value, "Restart button", false);
    value = toggleSelection(value, "Turn indicator", false);
    value = toggleSelection(value, "Score tracking across rounds", false);
    expect(parseSelections(value)).toEqual([
      "Restart button",
      "Turn indicator",
      "Score tracking across rounds",
    ]);
  });
});