import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_MODEL_ID } from "@/data/models";
import { buildPlan } from "@/lib/planner";

/**
 * The prompt is written by the internal model, so these tests run the whole
 * pipeline against a stubbed provider. Cost, feasibility and model selection
 * stay deterministic regardless of what the stub returns.
 */
const STUB_PROMPT = [
  "ROLE",
  "Act as a senior engineer.",
  "",
  "OBJECTIVE",
  "Deliver the requested work completely.",
  "",
  "CONTEXT",
  "The requester supplied a task and a budget in CREDIT.",
  "",
  "REQUIREMENTS",
  "- Satisfy the stated objective.",
  "",
  "SCOPE",
  "- The core deliverable.",
  "",
  "OUT OF SCOPE",
  "- Anything not listed under SCOPE.",
  "",
  "PRIORITIES",
  "- Correctness first.",
  "",
  "EXECUTION STRATEGY",
  "- Work through the objective in order.",
  "",
  "CONSTRAINTS",
  "- Keep the output focused.",
  "",
  "BUDGET CONSTRAINT",
  "- Stay within the stated CREDIT budget.",
  "",
  "VALIDATION",
  "- Check the result against every requirement.",
  "",
  "REVISION POLICY",
  "- Use targeted corrections.",
  "",
  "STOPPING CONDITIONS",
  "- Stop when the work is complete.",
  "",
  "OUTPUT FORMAT",
  "- Return the finished work directly.",
].join("\n");

/**
 * A single stub serving both stages in order: the analyst's JSON first, then
 * the writer's prompt. Analysis is no longer allowed to fall back to a
 * heuristic when the model fails, so a stub that only returns prompt text
 * would make the pipeline fail for an unrelated reason.
 */
const STUB_ANALYSIS = JSON.stringify({
  taskType: "web-development",
  summary: "Build a responsive SaaS landing page.",
  complexity: "medium",
  requiredCapabilities: ["code generation", "architectural reasoning"],
  estimatedInputTokens: 120000,
  estimatedOutputTokens: 80000,
  expectedIterations: 3,
  toolRequirements: ["file editing", "test runner"],
  phases: [
    { name: "Requirements", description: "Confirm scope and acceptance criteria", priority: "essential", costWeight: 0.15 },
    { name: "Implementation", description: "Build the page sections", priority: "essential", costWeight: 0.5 },
    { name: "Review", description: "Validate responsiveness and finalize", priority: "recommended", costWeight: 0.35 },
  ],
  risks: ["Scope can expand if extra sections are added late"],
  scopeAdjustments: ["Ship the core sections first"],
});

/**
 * Deliberately large: enough to exceed a 5 CREDIT budget on the same target
 * model, which is what puts the scope-optimizer on the path being tested.
 * These two constants are what make the scope tests exercise the mechanism
 * rather than passing because an estimate happens to be small.
 */
const STUB_LARGE_ANALYSIS = JSON.stringify({
  taskType: "web-development",
  summary: "Build a complete ecommerce platform.",
  complexity: "very-high",
  requiredCapabilities: ["code generation", "architectural reasoning"],
  estimatedInputTokens: 900000,
  estimatedOutputTokens: 600000,
  expectedIterations: 5,
  toolRequirements: ["file editing", "terminal commands", "test runner"],
  phases: [
    { name: "Requirements", description: "Confirm scope and acceptance criteria", priority: "essential", costWeight: 0.1 },
    { name: "Architecture", description: "Decide structure and key decisions", priority: "essential", costWeight: 0.15 },
    { name: "Implementation", description: "Build the platform", priority: "essential", costWeight: 0.5 },
    { name: "Testing", description: "Verify behaviour", priority: "essential", costWeight: 0.15 },
    { name: "Final review", description: "Clean up and summarize", priority: "recommended", costWeight: 0.1 },
  ],
  risks: ["Payment handling adds compliance overhead"],
  scopeAdjustments: ["Ship the core purchase path first"],
});

/** Serves the large analysis when the task clearly exceeds a small budget. */
function stubProviderLarge() {
  return vi.fn().mockImplementation(async (_url: string, init?: { body?: string }) => {
    const body = String(init?.body ?? "");
    const isAnalysis = body.includes("return ONLY valid JSON");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: { content: isAnalysis ? STUB_LARGE_ANALYSIS : STUB_PROMPT },
          },
        ],
      }),
    };
  });
}

function stubProvider() {
  // Dispatch on what the request asks for rather than on a call counter:
  // several tests call buildPlan in this file, and each buildPlan makes two
  // calls (analysis, then writing), so a counter would drift between tests.
  return vi.fn().mockImplementation(async (_url: string, init?: { body?: string }) => {
    const body = String(init?.body ?? "");
    const isAnalysis = body.includes("return ONLY valid JSON");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { finish_reason: "stop", message: { content: isAnalysis ? STUB_ANALYSIS : STUB_PROMPT } },
        ],
      }),
    };
  });
}

const LANDING_PAGE =
  "Build a responsive SaaS landing page using Next.js, TypeScript and Tailwind. Include pricing, testimonials, FAQ, responsive navigation and a contact form.";

beforeEach(() => {
  process.env.AGENTFUND_AI_API_KEY = "test-key";
  process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
  process.env.AGENTFUND_AI_MODEL = "test-model";
  // Keep the retry path fast. These are read per call, so lowering the
  // per-attempt timeout does not weaken what the test asserts.
  process.env.AGENTFUND_AI_TIMEOUT_MS = "50";
  vi.stubGlobal("fetch", stubProvider());
});

/**
 * The point of the optimization: a completed task should cost exactly two LLM
 * calls, one per stage. Anything above that means a call is being repeated or a
 * stage is quietly re-running the model.
 */
describe("LLM call budget", () => {
  it("makes exactly two calls for a completed task", async () => {
    const fetchMock = stubProvider();
    vi.stubGlobal("fetch", fetchMock);

    await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses one call for analysis and one for prompt generation", async () => {
    const fetchMock = stubProvider();
    vi.stubGlobal("fetch", fetchMock);

    await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    const bodies = fetchMock.mock.calls.map((call) => String((call[1] as { body: string }).body));
    // The analyser is the JSON request; the writer is the prompt request.
    expect(bodies[0]).toContain("return ONLY valid JSON");
    expect(bodies[1]).not.toContain("return ONLY valid JSON");
  });

  it("gives the analysis call its own small token cap", async () => {
    const fetchMock = stubProvider();
    vi.stubGlobal("fetch", fetchMock);
    process.env.AGENTFUND_AI_ANALYSIS_MAX_TOKENS = "1800";
    process.env.AGENTFUND_AI_PROMPT_MAX_TOKENS = "3500";

    await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as { body: string }).body)) as { max_tokens: number },
    );
    // Analysis is capped far below the prompt stage, and both are modest.
    expect(bodies[0].max_tokens).toBe(1800);
    expect(bodies[1].max_tokens).toBe(3500);
  });

  it("never lets the deprecated AI_MAX_TOKENS inflate either call", async () => {
    const fetchMock = stubProvider();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.AGENTFUND_AI_ANALYSIS_MAX_TOKENS;
    delete process.env.AGENTFUND_AI_PROMPT_MAX_TOKENS;
    process.env.AI_MAX_TOKENS = "48000";

    await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as { body: string }).body)) as { max_tokens: number },
    );
    expect(bodies[0].max_tokens).toBe(1800);
    expect(bodies[1].max_tokens).toBe(3500);
  });

  it("reports per-stage timings so a slow stage is identifiable", async () => {
    vi.stubGlobal("fetch", stubProvider());

    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    expect(plan.analysisDurationMs).toBeGreaterThanOrEqual(0);
    expect(plan.promptDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("planning pipeline", () => {
  it("produces a complete plan for a medium task with auto model selection", async () => {
    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: AUTO_MODEL_ID,
      optimization: "balanced",
      budget: 10,
    });

    expect(plan.autoSelected).toBe(true);
    expect(plan.recommendation).not.toBeNull();
    expect(plan.modelId).toBeTruthy();
    expect(plan.cost.minimum).toBeGreaterThan(0);
    expect(plan.cost.maximum).toBeGreaterThan(plan.cost.minimum);
    expect(plan.reserve.recommendedReserve).toBeGreaterThanOrEqual(0);
    expect(plan.analysis.phases.length).toBeGreaterThan(0);
    expect(plan.executionPlan.steps.length).toBeGreaterThan(0);
    expect(plan.comparison.length).toBeGreaterThan(0);
    expect(plan.promptSource).toBe("ai");
    expect(plan.prompt).toContain("ROLE");
  });

  it("honours an explicitly selected model", async () => {
    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    expect(plan.modelId).toBe("claude-sonnet");
    expect(plan.autoSelected).toBe(false);
    expect(plan.recommendation).toBeNull();
  });

  it("offers scope optimization for a large task with a small budget", async () => {
    vi.stubGlobal("fetch", stubProviderLarge());
    const plan = await buildPlan({
      taskDescription:
        "Build a complete ecommerce platform with authentication, real payment processing, admin dashboard, order management, analytics and a full test suite.",
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 5,
    });

    expect(plan.optimizedScope).not.toBeNull();
    expect(plan.optimizedScope!.included.length).toBeGreaterThan(0);
    expect(plan.optimizedScope!.deferred.length).toBeGreaterThan(0);
    expect(plan.feasibility.status).not.toBe("fits");
  });

  it("lowers the estimate when the optimized scope is applied", async () => {
    vi.stubGlobal("fetch", stubProviderLarge());
    const request = {
      taskDescription:
        "Build a complete ecommerce platform with authentication, real payment processing, admin dashboard, order management and analytics.",
      modelId: "claude-sonnet",
      optimization: "balanced" as const,
      budget: 5,
    };

    const original = await buildPlan(request);
    const optimized = await buildPlan({ ...request, applyOptimizedScope: true });

    expect(optimized.scopeApplied).toBe(true);
    expect(optimized.cost.maximum).toBeLessThan(original.cost.maximum);
  });

  it("reports fits for a small task with a large budget", async () => {
    const plan = await buildPlan({
      taskDescription: "Write a short thank-you email to a client.",
      modelId: "gpt-4o-mini",
      optimization: "balanced",
      budget: 50,
    });

    expect(plan.feasibility.status).toBe("fits");
    expect(plan.optimizedScope).toBeNull();
  });

  it("handles a decimal budget", async () => {
    const plan = await buildPlan({
      taskDescription: "Summarize this quarter's sales data and highlight trends.",
      modelId: "gpt-4o-mini",
      optimization: "minimize-cost",
      budget: 2.5,
    });

    expect(plan.budget).toBe(2.5);
    expect(Number.isFinite(plan.cost.minimum)).toBe(true);
  });

  it("carries clarifying answers through the pipeline", async () => {
    const plan = await buildPlan({
      taskDescription: "build a tic-tac-toe game",
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 10,
      clarifyingQuestions: [
        {
          id: "game_mode",
          question: "Should it be single-player or multiplayer?",
          defaultValue: "Two players sharing the same screen, taking turns.",
        },
        {
          id: "game_extras",
          question: "Which extras do you want?",
          defaultValue: "A restart button and a clear indicator of whose turn it is.",
        },
      ],
      clarifyingResponses: {
        game_mode: "Single player against the computer",
        game_extras: "Restart button, Turn indicator, Score tracking across rounds",
      },
    });

    expect(plan.answersUsed).toBe(true);
    expect(plan.clarifyingAnswers).toHaveLength(2);
    expect(plan.clarifyingAnswers[0].answer).toBe("Single player against the computer");
    expect(plan.clarifyingAnswers[1].answer).toBe(
      "Restart button, Turn indicator, Score tracking across rounds",
    );
  });

  it("marks unanswered questions as defaults without blocking the run", async () => {
    const plan = await buildPlan({
      taskDescription: "build a tic-tac-toe game",
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 10,
      clarifyingQuestions: [
        {
          id: "game_mode",
          question: "Should it be single-player or multiplayer?",
          defaultValue: "Two players sharing the same screen, taking turns.",
        },
      ],
    });

    expect(plan.answersUsed).toBe(false);
    expect(plan.clarifyingAnswers[0].answered).toBe(false);
    expect(plan.clarifyingAnswers[0].answer).toBe(
      "Two players sharing the same screen, taking turns.",
    );
    expect(plan.prompt.length).toBeGreaterThan(0);
  });

  it("generates a prompt that mentions the budget and never claims to execute", async () => {
    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 10,
    });

    expect(plan.prompt).toContain("CREDIT");
    expect(plan.prompt.toLowerCase()).not.toContain("run with orbio");
  });

  it("fails loudly when the model cannot be reached, instead of falling back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    // The whole point: no heuristic substitute is returned, and the failure is
    // a structured error the API can report rather than a silent success.
    await expect(
      buildPlan({
        taskDescription: LANDING_PAGE,
        modelId: "claude-sonnet",
        optimization: "balanced",
        budget: 10,
      }),
    ).rejects.toMatchObject({ name: "AiError", retryable: expect.any(Boolean) });
  });

  it("reports a missing configuration by name instead of a generic failure", async () => {
    delete process.env.AGENTFUND_AI_MODEL;

    await expect(
      buildPlan({
        taskDescription: LANDING_PAGE,
        modelId: "claude-sonnet",
        optimization: "balanced",
        budget: 10,
      }),
    ).rejects.toMatchObject({ code: "BACKEND_NOT_CONFIGURED" });
  });

  it("never substitutes the internal model for the user's target model", async () => {
    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    // The user picked claude-sonnet; AgentFund's own model is test-model and
    // must not leak into the target slot.
    expect(plan.modelId).toBe("claude-sonnet");
    expect(plan.agentModel).toBe("test-model");
    expect(plan.agentModel).not.toBe(plan.modelId);
  });
});
