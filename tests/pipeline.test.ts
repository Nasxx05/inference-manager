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

function stubProvider() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ finish_reason: "stop", message: { content: STUB_PROMPT } }],
    }),
  });
}

beforeEach(() => {
  // Task analysis stays heuristic; only the prompt writer needs a provider.
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
  process.env.AI_API_KEY = "test-key";
  process.env.AI_BASE_URL = "https://example.test/v1";
  process.env.AI_MODEL = "test-model";
  vi.stubGlobal("fetch", stubProvider());
});

const LANDING_PAGE =
  "Build a responsive SaaS landing page using Next.js, TypeScript and Tailwind. Include pricing, testimonials, FAQ, responsive navigation and a contact form.";

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

  it("fails loudly when the prompt model cannot be reached, instead of falling back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(
      buildPlan({
        taskDescription: LANDING_PAGE,
        modelId: "claude-sonnet",
        optimization: "balanced",
        budget: 10,
      }),
    ).rejects.toThrow();
  });
});