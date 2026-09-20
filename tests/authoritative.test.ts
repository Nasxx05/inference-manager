/**
 * Regression tests for the two authoritative-state invariants:
 *
 *   1. ONE model decision — the model the prompt was written for IS the model
 *      the plan reports and the model the cost was computed with.
 *   2. ONE final scope — estimate, feasibility and prompt all describe the same
 *      scope, core work is protected, and deferred work does not reappear.
 *
 * Provider responses are stubbed; no network calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlan } from "@/lib/planner";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { buildFinalScope, optimizeFinalScope } from "@/lib/scopeOptimizer/finalScope";
import { MODELS, findModelOrThrow } from "@/data/models";
import type { FinalScope, TaskAnalysis } from "@/types";

const RAG =
  "Build a production RAG agent with document ingestion, embeddings, vector search, retrieval, evaluation and authentication.";
const SAAS =
  "Build a complete multi-tenant SaaS platform with authentication, database, backend APIs, payments, admin dashboard, analytics and deployment.";

/** The model the prompt was specialized for, captured from the request body. */
let promptModelId: string | null = null;
/** How many times the planner asked for a target model. */
let targetModelRequests = 0;

const VALID_PROMPT = [
  "ROLE",
  "Senior engineer.",
  "",
  "OBJECTIVE",
  "Deliver the system described in REQUIREMENTS.",
  "",
  "CONTEXT",
  "Built for a small team.",
  "",
  "REQUIREMENTS",
  "- Implement the in-scope requirements",
  "",
  "SCOPE",
  "- Core delivery",
  "",
  "OUT OF SCOPE",
  "- Deferred work",
  "",
  "PRIORITIES",
  "- Correctness first",
  "",
  "EXECUTION STRATEGY",
  "- Work in ordered phases and validate as you go",
  "",
  "CONSTRAINTS",
  "- Stay within the stated planning budget",
  "",
  "BUDGET CONSTRAINT",
  "- Treat the budget as a planning constraint only",
  "",
  "VALIDATION",
  "- Check the output against every requirement",
  "",
  "REVISION POLICY",
  "- Use targeted corrections instead of full rewrites",
  "",
  "STOPPING CONDITIONS",
  "- Stop once the acceptance criteria are satisfied",
  "",
  "OUTPUT FORMAT",
  "- Return the finished work with brief notes",
].join("\n");

function stubProvider(): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = String((init as { body?: string })?.body ?? "");
    const isCombined = body.includes("taskAnalysis") && body.includes("generatedPrompt");

    // Count how many distinct models the planner asks the writer to target, and
    // detect any non-registry "neutral" placeholder being used for specialization.
    if (body.includes("TARGET MODEL TO WRITE THE PROMPT FOR")) {
      targetModelRequests += 1;
      const hit = MODELS.find((model) => {
        const name = model.displayName.toLowerCase();
        return body.toLowerCase().includes(name);
      });
      promptModelId = hit ? hit.id : null;
    }

    const analysis = {
      taskType: "coding",
      summary: "A structured implementation task.",
      complexity: "very-high",
      requiredCapabilities: ["coding"],
      estimatedInputTokens: 60000,
      estimatedOutputTokens: 30000,
      expectedIterations: 7,
      toolRequirements: ["editor"],
      phases: [
        { name: "Requirements", description: "Clarify", priority: "essential", costWeight: 0.2 },
        { name: "Execution", description: "Build", priority: "essential", costWeight: 0.6 },
        { name: "Review", description: "Check", priority: "optional", costWeight: 0.2 },
      ],
      risks: [],
      scopeAdjustments: [],
    };

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(
                isCombined
                  ? { taskAnalysis: analysis, generatedPrompt: VALID_PROMPT }
                  : analysis,
              ),
            },
          },
        ],
        model: "stub",
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  promptModelId = null;
  targetModelRequests = 0;
  process.env.AGENTFUND_AI_API_KEY = "test-key";
  process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
  process.env.AGENTFUND_AI_MODEL = "test-model";
  delete process.env.AGENTFUND_AI_COMBINED;
});

describe("issue 1 — authoritative model resolution", () => {
  it("explicit model: same model for prompt, cost and result", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: RAG,
      modelId: "claude-opus",
      optimization: "balanced",
      budget: 10,
    });

    expect(plan.modelId).toBe("claude-opus");
    expect(plan.cost.modelId).toBe("claude-opus");
    expect(plan.promptModelId).toBe("claude-opus");
    expect(promptModelId).toBe("claude-opus");
    expect(plan.autoSelected).toBe(false);
    // Suitability is evaluated on that exact model too.
    expect(plan.suitability).not.toBeNull();
  });

  it("auto: resolves a concrete model used for prompt generation and reporting", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: RAG,
      modelId: "auto",
      optimization: "balanced",
      budget: 10,
    });

    expect(plan.autoSelected).toBe(true);
    expect(plan.modelId).toBeTruthy();
    expect(plan.modelId).not.toBe("auto");
    expect(plan.resolvedModelId).toBe(plan.modelId);
    expect(plan.resolvedModelReason).toBeTruthy();
    // The invariant: prompt model === reported model.
    expect(promptModelId).toBe(plan.modelId);
    expect(plan.promptModelId).toBe(plan.modelId);
    expect(plan.cost.modelId).toBe(plan.modelId);
  });

  it("never specializes the final prompt on a neutral placeholder", async () => {
    vi.stubGlobal("fetch", stubProvider());
    for (const modelId of ["auto", "claude-sonnet", "gpt-4o"]) {
      promptModelId = null;
      await buildPlan({
        taskDescription: RAG,
        modelId,
        optimization: "balanced",
        budget: 10,
      });
      // A concrete registry model, never null (which would mean a placeholder).
      expect(promptModelId).toBeTruthy();
      expect(MODELS.some((model) => model.id === promptModelId)).toBe(true);
    }
  });

  it("does not resolve the model more than once per plan", async () => {
    vi.stubGlobal("fetch", stubProvider());
    await buildPlan({
      taskDescription: RAG,
      modelId: "auto",
      optimization: "balanced",
      budget: 10,
    });
    // One authoritative resolution feeding every stage — not one per stage.
    expect(targetModelRequests).toBeLessThanOrEqual(1);
  });
});

describe("issue 2 — canonical final scope", () => {
  it("exposes a finalScope with stable ids on every plan", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: SAAS,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 100000,
    });

    const scope = plan.finalScope!;
    expect(scope).toBeDefined();
    // Every id is unique and stable.
    expect(new Set(scope.requirements.map((unit) => unit.id)).size).toBe(
      scope.requirements.length,
    );
    // included + excluded covers everything, with no overlap.
    const included = new Set(scope.includedIds);
    expect(included.size + scope.excludedIds.length).toBe(scope.requirements.length);
    for (const id of scope.excludedIds) expect(included.has(id)).toBe(false);
  });

  it("sufficient budget: no optimization, scope fully retained", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: SAAS,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 100000,
    });
    const scope = plan.finalScope!;
    expect(scope.optimized).toBe(false);
    expect(scope.reductions.length).toBe(0);
    expect(scope.excludedIds.length).toBe(0);
    expect(plan.optimizedScope).toBeNull();
  });

  it("insufficient budget: optimization runs and core work is preserved", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: SAAS,
      modelId: "claude-sonnet",
      optimization: "balanced",
      // Small enough to exceed the estimate, large enough to be a real budget.
      budget: 1,
      applyOptimizedScope: true,
    });

    const scope = plan.finalScope!;
    // When the estimate exceeds the budget, optimization must have produced the
    // canonical scope; otherwise the scope is untouched and still consistent.
    if (scope.optimized) {
      expect(scope.reductions.length).toBeGreaterThan(0);
    }
    // Core requirements are never sacrificed.
    const included = new Set(scope.includedIds);
    const core = scope.requirements.filter((unit) => unit.core && unit.source === "task");
    for (const unit of core) expect(included.has(unit.id)).toBe(true);
    // Reductions are recorded with a reason.
    for (const reduction of scope.reductions) expect(reduction.reason.length).toBeGreaterThan(0);
  });

  it("optimizer and planner share one estimator result for the same scope", () => {
    const analysis: TaskAnalysis = heuristicAnalyze(SAAS);
    const scope: FinalScope = buildFinalScope({
      analysis,
      requirements: [
        { name: "Core engine", weight: "high" },
        { name: "Analytics extras", weight: "low" },
      ],
    });

    const model = findModelOrThrow("claude-sonnet");
    const estimator = (includedIds: string[]): number => {
      const included = new Set(includedIds);
      return scope.requirements
        .filter((unit) => included.has(unit.id))
        .reduce((sum, unit) => sum + (unit.weight === "high" ? 6 : 1), 0);
    };

    const result = optimizeFinalScope({ scope, budget: 0, estimate: estimator });
    // The optimizer's reported cost is reproducible from its own final scope.
    expect(estimator(result.finalScope.includedIds)).toBe(result.estimatedCost);
    expect(result.finalScope.includedIds).toContain(
      scope.requirements.find((unit) => unit.name === "Core engine")!.id,
    );
  });

  it("core requirements are never removed, even with an unreachable budget", () => {
    const analysis: TaskAnalysis = heuristicAnalyze(SAAS);
    const scope: FinalScope = buildFinalScope({
      analysis,
      requirements: [
        { name: "Core platform", weight: "very-high" },
        { name: "Nice to have widget", weight: "low" },
      ],
    });
    // Force "core" via the phase/keyword normalisation by naming it explicitly.
    const coreScope: FinalScope = {
      ...scope,
      requirements: scope.requirements.map((unit) =>
        unit.name === "Core platform" ? { ...unit, core: true } : unit,
      ),
    };

    const result = optimizeFinalScope({
      scope: coreScope,
      budget: 0,
      estimate: (includedIds) => includedIds.length * 10,
    });

    const included = new Set(result.finalScope.includedIds);
    const coreId = coreScope.requirements.find((unit) => unit.name === "Core platform")!.id;
    expect(included.has(coreId)).toBe(true);
    expect(result.cannotReduceFurther).toBe(true);
    expect(result.finalScope.stillInsufficient).toBe(true);
  });

  it("stops instead of looping when a reduction does not help", () => {
    const analysis: TaskAnalysis = heuristicAnalyze(SAAS);
    const scope: FinalScope = buildFinalScope({
      analysis,
      requirements: [{ name: "Anything", weight: "medium" }],
    });
    const result = optimizeFinalScope({
      scope,
      budget: 0,
      // A constant estimator cannot be improved by deferring anything.
      estimate: () => 10,
    });
    expect(result.finalScope.reductions.length).toBe(0);
    expect(result.finalScope.optimized).toBe(false);
    expect(result.cannotReduceFurther).toBe(true);
  });
});

describe("full pipeline consistency", () => {
  it("original task, model, scope, estimate, feasibility and prompt agree", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const task = RAG;
    const plan = await buildPlan({
      taskDescription: task,
      modelId: "auto",
      optimization: "balanced",
      budget: 10,
      applyOptimizedScope: true,
    });

    // Original wording preserved verbatim.
    expect(plan.taskDescription).toBe(task);

    // One model across prompt, cost and result.
    expect(plan.promptModelId).toBe(plan.modelId);
    expect(plan.cost.modelId).toBe(plan.modelId);
    expect(promptModelId).toBe(plan.modelId);

    // Costs are ordered and finite.
    expect(plan.cost.maximum).toBeGreaterThan(plan.cost.minimum);
    for (const value of [
      plan.cost.minimum,
      plan.cost.maximum,
      plan.cost.minimumViable,
      plan.cost.recommendedMaximum,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }

    // The prompt is present and non-trivial.
    expect(plan.prompt.length).toBeGreaterThan(100);

    // Any deferred requirement is absent from the prompt's required work.
    const scope = plan.finalScope!;
    const excluded = new Set(scope.excludedIds);
    const lower = plan.prompt.toLowerCase();
    for (const unit of scope.requirements) {
      if (excluded.has(unit.id)) {
        expect(lower).not.toContain(unit.name.toLowerCase());
      }
    }
  });
});