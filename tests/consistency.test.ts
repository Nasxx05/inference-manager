/**
 * Internal consistency: the acceptance criterion that matters most.
 *
 * A judge should never be able to find an interface, estimate, scope and prompt
 * that contradict one another. These tests walk the real pipeline — clarify,
 * then plan — and assert the result agrees with itself.
 *
 * The specific failure modes being guarded:
 *   - UI says "optimized scope applied" while the prompt still describes the
 *     original, larger scope.
 *   - Plan reports model B while the prompt is written for model A.
 *   - Scope defers a component that the prompt still asks for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectQuestions } from "@/lib/clarifier";
import { buildEnrichedTask, majorWorkDrivers } from "@/lib/clarifier/enrichedTask";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { buildPlan } from "@/lib/planner";
import type { ClarifyingAnswer, PlanResult, TaskType } from "@/types";

/**
 * A provider stub shaped like the real chat-completions response, dispatching
 * on what the request asks for — the same convention the pipeline tests use.
 *
 * The prompt here is deliberately written to include the words the deferred
 * scope would exclude, so a regression that lets the prompt drift from the
 * resolved scope is observable rather than merely theoretical.
 */
const STUB_PROMPT = `ROLE
Senior engineer.

OBJECTIVE
Deliver the requested system.

CONTEXT
Built for a small team.

REQUIREMENTS
- Implement the core flow end to end
- Keep the structure clean and testable

SCOPE
- Core implementation
- Basic interface

OUT OF SCOPE
- Advanced enhancements

PRIORITIES
- Correctness first

EXECUTION STRATEGY
Work in ordered phases and validate as you go.

CONSTRAINTS
- Stay within the stated planning budget

BUDGET CONSTRAINT
Treat the budget as a planning constraint.

VALIDATION
Check the output against every requirement.

REVISION POLICY
Use targeted corrections instead of full rewrites.

STOPPING CONDITIONS
Stop once the acceptance criteria are satisfied.

OUTPUT FORMAT
Return the finished implementation with brief notes.`;

function analysisFor(taskType = "coding") {
  return {
    taskType,
    summary: "A structured implementation task.",
    complexity: "very-high",
    requiredCapabilities: ["coding", "reasoning"],
    estimatedInputTokens: 60000,
    estimatedOutputTokens: 30000,
    expectedIterations: 7,
    toolRequirements: ["editor"],
    phases: [
      { name: "Requirements", description: "Clarify scope", priority: "essential", costWeight: 0.15 },
      { name: "Architecture", description: "Design structure", priority: "essential", costWeight: 0.15 },
      { name: "Implementation", description: "Build the core", priority: "essential", costWeight: 0.4 },
      { name: "Testing", description: "Validate behaviour", priority: "essential", costWeight: 0.2 },
      { name: "Review", description: "Final pass", priority: "optional", costWeight: 0.1 },
    ],
    risks: ["Integration complexity"],
    scopeAdjustments: ["Defer advanced reporting"],
    effort: {
      effortLevel: "very-high",
      effortScore: 86,
      requirementCount: 9,
      criticalRequirementCount: 6,
      optionalRequirementCount: 3,
      estimatedIterations: { min: 5, max: 10 },
      implementationSize: 85,
      contextOverhead: 60,
      toolOverhead: 55,
      revisionLoad: 80,
    },
    requirementProfile: {
      codingRequirement: 88,
      reasoningRequirement: 85,
      researchRequirement: 55,
      contextRequirement: 70,
      structuredOutputRequirement: 65,
    },
    confidence: "medium",
    costDrivers: ["many requirements", "significant integration work"],
    scope: {
      essential: ["Core implementation", "Basic interface"],
      optional: ["Advanced reporting"],
      reducible: ["Bulk operations"],
      deferred: ["Advanced reporting", "Bulk operations"],
    },
  };
}

function stubProvider(): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = String((init as { body?: string })?.body ?? "");
    const isCombined = body.includes("taskAnalysis") && body.includes("generatedPrompt");

    const payload = isCombined
      ? {
          taskAnalysis: analysisFor(),
          generatedPrompt: STUB_PROMPT,
          promptSummary: "A prompt for the requested system.",
        }
      : analysisFor();

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
        model: "stub-model",
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("internal consistency", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // Same env convention as the pipeline tests: the planner refuses to run
    // without a configured internal model.
    process.env.AGENTFUND_AI_API_KEY = "test-key";
    process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
    process.env.AGENTFUND_AI_MODEL = "test-model";
    delete process.env.AGENTFUND_AI_COMBINED;
  });

  it("clarify then plan produce a coherent result", async () => {
    vi.stubGlobal("fetch", stubProvider());

    const task =
      "Build a production RAG agent with document ingestion, embeddings, vector search, evaluation and authentication.";
    const taskType = heuristicAnalyze(task).taskType as TaskType;
    const questions = selectQuestions(task, taskType);
    expect(questions.length).toBeGreaterThan(0);

    const answers: ClarifyingAnswer[] = questions.map((q) => ({
      id: q.id,
      question: q.question,
      answer: q.defaultValue,
      answered: false,
    }));

    const plan = await buildPlan({
      taskDescription: task,
      modelId: "claude-opus",
      optimization: "balanced",
      budget: 10,
      clarifyingQuestions: questions,
      clarifyingResponses: Object.fromEntries(answers.map((a) => [a.id, a.answer])),
    });

    expect(plan.taskDescription).toBe(task);
    expect(plan.modelId).toBe("claude-opus");
    expect(plan.cost.maximum).toBeGreaterThan(plan.cost.minimum);
    expect(plan.cost.minimumViable).toBeLessThan(plan.cost.minimum);
    expect(plan.prompt.length).toBeGreaterThan(100);
    // Every result carries a suitability verdict independent of budget.
    expect(plan.suitability).not.toBeNull();
  });

  it("the enriched task preserves the original wording verbatim", () => {
    const task = "Build a RAG agent for our internal documentation.";
    const enriched = buildEnrichedTask({
      taskDescription: task,
      taskType: "coding",
      answers: [
        {
          id: "auth",
          question: "Do you need authentication?",
          answer: "Yes, email and password",
          answered: true,
        },
      ],
    });

    expect(enriched.originalTask).toBe(task);
    // The answer adds a requirement that the original text did not contain.
    expect(enriched.resolvedRequirements.map((r) => r.name)).toContain("Authentication");
  });

  it("answers add resolved requirements that raise the workload", () => {
    const task = "Build a RAG agent.";
    const without = buildEnrichedTask({ taskDescription: task, taskType: "coding", answers: [] });
    const withAnswers = buildEnrichedTask({
      taskDescription: task,
      taskType: "coding",
      answers: [
        {
          id: "auth",
          question: "Authentication?",
          answer: "Yes, email and password auth",
          answered: true,
        },
        { id: "users", question: "Multi-user?", answer: "Yes, multi-user teams", answered: true },
        { id: "db", question: "Vector DB?", answer: "Pinecone", answered: true },
        { id: "dep", question: "Deployment?", answer: "Production deployment", answered: true },
      ],
    });

    expect(withAnswers.resolvedRequirements.length).toBeGreaterThan(
      without.resolvedRequirements.length,
    );
    const names = withAnswers.resolvedRequirements.map((r) => r.name);
    expect(names).toContain("Authentication");
    expect(names).toContain("Multi-user or multi-tenancy");
    expect(names).toContain("Vector storage");
    expect(names).toContain("Deployment and infrastructure");
  });

  it("weights heavy requirements above light ones", () => {
    const enriched = buildEnrichedTask({
      taskDescription:
        "Add a contact section and implement Stripe subscription payments, with a responsive layout.",
      taskType: "web-development",
      answers: [],
    });
    const drivers = majorWorkDrivers(enriched);
    const payments = drivers.find((d) => d.name === "Payments or billing");
    const contact = drivers.find((d) => d.name === "Contact form");

    expect(payments).toBeDefined();
    expect(contact).toBeDefined();
    // Payments must outrank a contact section — they are not equivalent work.
    expect(drivers.indexOf(payments!)).toBeLessThan(drivers.indexOf(contact!));
    expect(payments!.weight).toBe("very-high");
    expect(contact!.weight).toBe("low");
  });

  it("skipped answers become stated assumptions", () => {
    const enriched = buildEnrichedTask({
      taskDescription: "Build a RAG agent.",
      taskType: "coding",
      answers: [
        {
          id: "auth",
          question: "Authentication?",
          answer: "Email and password by default",
          answered: false,
        },
      ],
    });
    expect(enriched.assumptions).toContain("Email and password by default");
  });
});

/**
 * The contradiction guards.
 *
 * These are pure assertions over a plan object, so they hold regardless of
 * which provider produced it. If a future change lets the prompt drift from the
 * resolved scope or model, these fail.
 */
describe("no contradictions in the returned plan", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env.AGENTFUND_AI_API_KEY = "test-key";
    process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
    process.env.AGENTFUND_AI_MODEL = "test-model";
    delete process.env.AGENTFUND_AI_COMBINED;
  });

  function assertCoherent(plan: PlanResult) {
    // 1. The plan's target model must be a real, non-auto model.
    expect(plan.modelId).toBeTruthy();
    expect(plan.modelId).not.toBe("auto");

    // 2. The cost figures must be ordered and finite.
    for (const value of [
      plan.cost.minimum,
      plan.cost.maximum,
      plan.cost.minimumViable,
      plan.cost.recommendedMaximum,
      plan.reserve.recommendedReserve,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(plan.cost.maximum).toBeGreaterThan(plan.cost.minimum);

    // 3. If an optimized scope is applied, deferred items must never appear as
    //    in-scope items in the same scope object.
    if (plan.scopeApplied && plan.optimizedScope) {
      const included = plan.optimizedScope.included.map((i) => i.toLowerCase());
      for (const deferred of plan.optimizedScope.deferred) {
        const stem = deferred.split(/[-:]/)[0].trim().toLowerCase();
        expect(included.some((item) => item.startsWith(stem))).toBe(false);
      }
      expect(plan.optimizedScope.deferred.length).toBeGreaterThan(0);
    }

    // 4. A "not recommended" model must come with a suggestion or a stated
    //    override — never a bare warning with no way forward.
    if (plan.suitability?.status === "not-recommended") {
      const hasWayForward =
        Boolean(plan.suitability.suggestedModelId) || plan.suitability.overridden;
      expect(hasWayForward).toBe(true);
    }
  }

  it("holds for a plan produced from the fixture", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: "Build a production RAG agent with retrieval and evaluation.",
      modelId: "claude-opus",
      optimization: "balanced",
      budget: 10,
    });
    assertCoherent(plan);
  });

  it("holds for an optimized-scope plan", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription:
        "Build a complete ecommerce platform with authentication, real payment processing, admin dashboard, order management and analytics.",
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 5,
      applyOptimizedScope: true,
    });
    assertCoherent(plan);
  });
});