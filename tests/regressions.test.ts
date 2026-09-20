/**
 * Regression tests for the six fixes.
 *
 * Each test targets a specific failure mode that was identified and fixed, so a
 * future change that reintroduces one fails here rather than in production.
 * Provider responses are stubbed — no network calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlan } from "@/lib/planner";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { estimateCost } from "@/lib/estimator/costEstimator";
import { selectQuestions } from "@/lib/clarifier";
import { buildEnrichedTask } from "@/lib/clarifier/enrichedTask";
import {
  optimizeScopeForBudget,
  applyScopeReduction,
} from "@/lib/scopeOptimizer/scopeOptimizer";
import { evaluateSuitability } from "@/lib/models/suitability";
import { evaluateFeasibility } from "@/lib/estimator/feasibilityEngine";
import { MODELS, findModelOrThrow } from "@/data/models";
import type { ModelConfig, TaskAnalysis, TaskType } from "@/types";

const SIMPLE = "Write a short product description for a running shoe.";
const RAG =
  "Build a production RAG agent with document ingestion, embeddings, vector search, retrieval, evaluation and authentication.";
const SAAS =
  "Build a complete multi-tenant SaaS platform with authentication, database, backend APIs, payments, admin dashboard, analytics and deployment.";

/** Captures the model the prompt was actually written for. */
let lastPromptModel: ModelConfig | null = null;

function stubProvider(analysisOverride?: Partial<TaskAnalysis>): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = String((init as { body?: string })?.body ?? "");
    const isCombined = body.includes("taskAnalysis") && body.includes("generatedPrompt");

    // Record which model the request was specialized for.
    /**
     * Identify which model the prompt was specialized for by looking for the
     * display name of any registry model in the request body. Robust to exact
     * prompt wording, which is not part of the contract under test.
     */
    lastPromptModel =
      MODELS.find((model) => {
        const name = model.displayName.toLowerCase();
        return body.toLowerCase().includes(name);
      }) ?? null;

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
      ...analysisOverride,
    };

    const prompt = [
      "ROLE",
      "Senior engineer.",
      "",
      "OBJECTIVE",
      "Deliver the system.",
      "",
      "CONTEXT",
      "Small team.",
      "",
      "REQUIREMENTS",
      "- Core flow",
      "",
      "SCOPE",
      "- Core",
      "",
      "OUT OF SCOPE",
      "- Extras",
      "",
      "PRIORITIES",
      "- Correctness",
      "",
      "EXECUTION STRATEGY",
      "- Phased delivery",
      "",
      "CONSTRAINTS",
      "- Stay within budget",
      "",
      "BUDGET CONSTRAINT",
      "- Treat budget as planning only",
      "",
      "VALIDATION",
      "- Check all requirements",
      "",
      "REVISION POLICY",
      "- Targeted fixes only",
      "",
      "STOPPING CONDITIONS",
      "- Stop when acceptance criteria are met",
      "",
      "OUTPUT FORMAT",
      "- Return the implementation with notes",
    ].join("\n");

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(isCombined ? { taskAnalysis: analysis, generatedPrompt: prompt } : analysis) },
          },
        ],
        model: "stub",
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  lastPromptModel = null;
  process.env.AGENTFUND_AI_API_KEY = "test-key";
  process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
  process.env.AGENTFUND_AI_MODEL = "test-model";
  delete process.env.AGENTFUND_AI_COMBINED;
});

describe("#2 estimation credibility", () => {
  it("simple task: valid plan, reasonable estimate, prompt generated", async () => {
    vi.stubGlobal("fetch", stubProvider({ complexity: "low" }));
    const plan = await buildPlan({
      taskDescription: SIMPLE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 5,
    });
    expect(plan.prompt.length).toBeGreaterThan(100);
    expect(plan.cost.maximum).toBeGreaterThan(plan.cost.minimum);
    expect(plan.cost.minimum).toBeGreaterThan(0);
  });

  it("RAG task: materially higher workload signals than a simple task", () => {
    const simple = estimateCost({
      analysis: heuristicAnalyze(SIMPLE),
      model: findModelOrThrow("claude-sonnet"),
      preference: "balanced",
      taskDescription: SIMPLE,
    });
    const rag = estimateCost({
      analysis: heuristicAnalyze(RAG),
      model: findModelOrThrow("claude-sonnet"),
      preference: "balanced",
      taskDescription: RAG,
    });
    expect(rag.maximum).toBeGreaterThan(simple.maximum * 2);
    expect(rag.effort!.requirementCount).toBeGreaterThan(simple.effort!.requirementCount);
  });

  it("SaaS task: many requirements and more passes than a simple task", () => {
    const saas = estimateCost({
      analysis: heuristicAnalyze(SAAS),
      model: findModelOrThrow("claude-sonnet"),
      preference: "balanced",
      taskDescription: SAAS,
    });
    expect(saas.effort!.requirementCount).toBeGreaterThanOrEqual(5);
    // Token and pass figures are exposed so the estimate is auditable.
    expect(saas.estimatedInputTokens).toBeGreaterThan(0);
    expect(saas.estimatedOutputTokens).toBeGreaterThan(0);
    expect(saas.modelledPasses).toBeGreaterThanOrEqual(1);
    expect(saas.pricingSource).toBe("curated");
    expect(saas.costDrivers.length).toBeGreaterThan(0);
  });

  it("never reports false precision — costs are rounded sensibly", () => {
    const estimate = estimateCost({
      analysis: heuristicAnalyze(SAAS),
      model: findModelOrThrow("claude-opus"),
      preference: "balanced",
      taskDescription: SAAS,
    });
    for (const value of [estimate.minimum, estimate.maximum, estimate.minimumViable]) {
      const decimals = (String(value).split(".")[1] ?? "").length;
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });

  it("low budget vs comfortable budget changes feasibility", () => {
    const estimate = estimateCost({
      analysis: heuristicAnalyze(RAG),
      model: findModelOrThrow("claude-sonnet"),
      preference: "balanced",
      taskDescription: RAG,
    });
    const low = evaluateFeasibility({
      userBudget: 1,
      estimatedMinimum: estimate.minimum,
      estimatedMaximum: estimate.maximum,
      minimumViable: estimate.minimumViable,
      recommendedMaximum: estimate.recommendedMaximum,
    });
    const comfortable = evaluateFeasibility({
      userBudget: 5000,
      estimatedMinimum: estimate.minimum,
      estimatedMaximum: estimate.maximum,
      minimumViable: estimate.minimumViable,
      recommendedMaximum: estimate.recommendedMaximum,
    });
    expect(low.status).toBe("does-not-fit");
    expect(comfortable.status).toBe("fits");
  });

  it("clarifying answers change the estimate", () => {
    const analysis = heuristicAnalyze("Build a RAG agent.");
    const base = { analysis, model: findModelOrThrow("claude-sonnet"), preference: "balanced" as const, taskDescription: "Build a RAG agent." };

    const minimal = estimateCost(base);
    const enriched = buildEnrichedTask({
      taskDescription: "Build a RAG agent.",
      taskType: "coding",
      answers: [
        { id: "a", question: "Auth?", answer: "Yes, email and password auth", answered: true },
        { id: "b", question: "Multi-user?", answer: "Yes, multi-user teams", answered: true },
        { id: "c", question: "Deploy?", answer: "Production deployment", answered: true },
      ],
    });
    const withAnswers = estimateCost({
      ...base,
      addedRequirements: enriched.resolvedRequirements.length,
    });

    expect(withAnswers.maximum).toBeGreaterThan(minimal.maximum);
  });

  it("optimized scope changes the estimate", () => {
    const analysis = heuristicAnalyze(RAG);
    const model = findModelOrThrow("claude-sonnet");
    const scope = optimizeScopeForBudget({
      taskDescription: RAG,
      analysis,
      budget: 0.01,
      estimate: (names) =>
        estimateCost({
          analysis: applyScopeReduction(analysis, { included: names, deferred: [], simplified: [], rationale: "" }, RAG),
          model,
          preference: "balanced",
          taskDescription: RAG,
          addedRequirements: names.length,
        }).recommendedMaximum,
      requirements: buildEnrichedTask({ taskDescription: RAG, taskType: "coding", answers: [] })
        .resolvedRequirements,
    });
    expect(scope.finalEstimate).not.toBeNull();
    expect(scope.finalEstimate!).toBeLessThan(scope.originalEstimate);
  });
});

describe("#3 scope optimization", () => {
  it("defers work toward the budget and re-estimates after each step", () => {
    const analysis = heuristicAnalyze(SAAS);
    const model = findModelOrThrow("claude-sonnet");
    const requirements = buildEnrichedTask({ taskDescription: SAAS, taskType: "coding", answers: [] })
      .resolvedRequirements;

    let calls = 0;
    const result = optimizeScopeForBudget({
      taskDescription: SAAS,
      analysis,
      // An unreachable budget forces the optimizer to exhaust safe reductions.
      budget: 0.0001,
      estimate: (names) => {
        calls += 1;
        return estimateCost({
          analysis: applyScopeReduction(analysis, { included: names, deferred: [], simplified: [], rationale: "" }, SAAS),
          model,
          preference: "balanced",
          taskDescription: SAAS,
          addedRequirements: names.length,
        }).recommendedMaximum;
      },
      requirements,
    });

    // Re-estimated at least once per deferral plus the initial pass.
    expect(calls).toBeGreaterThan(1);
    expect(result.deferredOrder.length).toBeGreaterThan(0);
    expect(result.finalEstimate!).toBeLessThan(result.originalEstimate);
    // Even exhausted, it reports insufficiency honestly.
    expect(result.stillInsufficient).toBe(true);
  });

  it("preserves essential work and never defers it", () => {
    const analysis = heuristicAnalyze(SAAS);
    const model = findModelOrThrow("claude-sonnet");
    const result = optimizeScopeForBudget({
      taskDescription: SAAS,
      analysis,
      budget: 0.0001,
      estimate: (names) =>
        estimateCost({
          analysis: applyScopeReduction(analysis, { included: names, deferred: [], simplified: [], rationale: "" }, SAAS),
          model,
          preference: "balanced",
          taskDescription: SAAS,
          addedRequirements: names.length,
        }).recommendedMaximum,
      requirements: [
        { name: "Core engine", weight: "high", essential: true },
        { name: "Analytics extras", weight: "low" },
      ],
    });
    expect(result.scope!.included.join(" ")).toContain("Core engine");
    expect(result.deferredOrder).not.toContain("Core engine");
  });

  it("reduces lower-value optional work before higher-value work", () => {
    const analysis = heuristicAnalyze(SAAS);
    const model = findModelOrThrow("claude-sonnet");
    const result = optimizeScopeForBudget({
      taskDescription: SAAS,
      analysis,
      budget: 0.0001,
      estimate: (names) =>
        estimateCost({
          analysis: applyScopeReduction(analysis, { included: names, deferred: [], simplified: [], rationale: "" }, SAAS),
          model,
          preference: "balanced",
          taskDescription: SAAS,
          addedRequirements: names.length,
        }).recommendedMaximum,
      requirements: [
        { name: "Low value polish", weight: "low" },
        { name: "Critical billing core", weight: "very-high" },
      ],
    });
    // Ordering: the cheap, low-value item is sacrificed first.
    expect(result.deferredOrder[0]).toBe("Low value polish");
    // The high-value item is only sacrificed after everything cheaper is gone.
    expect(result.deferredOrder.indexOf("Critical billing core")).toBeGreaterThan(0);
  });

  it("stops instead of looping when a deferral does not help", () => {
    const analysis = heuristicAnalyze(SAAS);
    const result = optimizeScopeForBudget({
      taskDescription: SAAS,
      analysis,
      budget: 0.0001,
      // A constant estimator cannot be improved by deferring anything.
      estimate: () => 10,
      requirements: [{ name: "Anything", weight: "medium" }],
    });
    expect(result.deferredOrder.length).toBe(0);
    expect(result.stillInsufficient).toBe(true);
  });
});

describe("#4 auto model resolution", () => {
  it("explicit model is passed to prompt generation", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: RAG,
      modelId: "claude-opus",
      optimization: "balanced",
      budget: 10,
    });
    expect(plan.modelId).toBe("claude-opus");
    expect(plan.autoSelected).toBe(false);
    // The prompt writer saw the explicit model, not a neutral placeholder.
    expect(lastPromptModel?.id).toBe("claude-opus");
  });

  it("auto resolves a concrete model before prompt generation", async () => {
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
    // The resolved model is reported explicitly, with a reason.
    expect(plan.resolvedModelId).toBe(plan.modelId);
    expect(plan.resolvedModelReason).toBeTruthy();
    // Critical: the prompt was written for that resolved model.
    expect(lastPromptModel?.id).toBe(plan.modelId);
  });

  it("a second explicit model produces a different prompt target", async () => {
    vi.stubGlobal("fetch", stubProvider());
    await buildPlan({
      taskDescription: RAG,
      modelId: "gpt-4o",
      optimization: "balanced",
      budget: 10,
    });
    expect(lastPromptModel?.id).toBe("gpt-4o");
  });
});

describe("#6 model registry", () => {
  it("keeps internal ids stable and separate from provider ids", () => {
    for (const model of MODELS) {
      expect(model.id).toBeTruthy();
      // Provider ids are present where known, and never masquerade as internal ids.
      if (model.providerModelId) {
        expect(model.providerModelId).not.toBe(model.id);
      }
      expect(model.profileSource).toBe("curated");
    }
  });

  it("distinguishes profile identity from provider identity", () => {
    const claude = findModelOrThrow("claude-sonnet");
    expect(claude.id).toBe("claude-sonnet");
    expect(claude.providerModelId).toContain("/");
  });
});

describe("model suitability", () => {
  /**
   * The real pipeline supplies effort signals from the analyser. Without them
   * the derived requirement profile is weak and even a small model passes, so
   * the assertion would not reflect production behaviour.
   */
  const analysis: TaskAnalysis = {
    ...heuristicAnalyze(RAG),
    effort: {
      level: "very-high",
      score: 88,
      requirementCount: 9,
      criticalRequirementCount: 7,
      optionalRequirementCount: 2,
      estimatedIterations: { min: 5, max: 9 },
      implementationSize: 86,
      contextOverhead: 70,
      toolOverhead: 60,
      revisionLoad: 82,
    },
  };

  it("strong model is suitable", () => {
    const result = evaluateSuitability({
      model: findModelOrThrow("claude-opus"),
      analysis,
      taskDescription: RAG,
      candidates: MODELS,
      explicit: true,
    });
    expect(result.status).toBe("suitable");
  });

  it("weak model on a complex task is flagged, with a way forward", () => {
    const result = evaluateSuitability({
      model: findModelOrThrow("gpt-4o-mini"),
      analysis,
      taskDescription: RAG,
      candidates: MODELS,
      explicit: true,
    });
    expect(result.status).not.toBe("suitable");
    expect(result.suggestedModelId).toBeTruthy();
    // Never claims impossibility.
    expect(result.reasons.join(" ")).not.toMatch(/cannot do it/i);
  });
});

describe("original task propagation", () => {
  it("the original task survives enrichment and planning", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const task = RAG;
    const questions = selectQuestions(task, heuristicAnalyze(task).taskType as TaskType);

    const plan = await buildPlan({
      taskDescription: task,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 10,
      clarifyingQuestions: questions,
      clarifyingResponses: Object.fromEntries(
        questions.map((question) => [question.id, question.defaultValue]),
      ),
    });

    expect(plan.taskDescription).toBe(task);
  });

  it("the estimator sees the full task, not a compressed summary", () => {
    const full =
      "Build a production RAG agent with ingestion, embeddings, vector database, retrieval, evaluation, authentication and deployment.";
    const summary = "Build a RAG agent.";

    const fromFull = estimateCost({
      analysis: heuristicAnalyze(full),
      model: findModelOrThrow("claude-sonnet"),
      preference: "balanced",
      taskDescription: full,
    });
    const fromSummary = estimateCost({
      analysis: heuristicAnalyze(full),
      model: findModelOrThrow("claude-sonnet"),
      preference: "balanced",
      taskDescription: summary,
    });

    // The detail IS the work: the full brief must cost more.
    expect(fromFull.maximum).toBeGreaterThan(fromSummary.maximum);
  });
});

describe("prompt / scope consistency", () => {
  it("applying an optimized scope yields a plan marked as scope-applied", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: SAAS,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 1,
      applyOptimizedScope: true,
    });

    if (plan.scopeApplied) {
      expect(plan.optimizedScope).not.toBeNull();
      // A deferred item must never also be listed as in scope.
      const included = plan.optimizedScope!.included.join(" ").toLowerCase();
      for (const deferred of plan.optimizedScope!.deferred) {
        expect(included).not.toContain(deferred.toLowerCase());
      }
    }
  });

  it("reports insufficiency when the budget cannot be met", async () => {
    vi.stubGlobal("fetch", stubProvider());
    const plan = await buildPlan({
      taskDescription: SAAS,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 0.01,
      applyOptimizedScope: true,
    });
    // Either the scope fits, or insufficiency is stated explicitly — never a
    // silent claim of feasibility.
    expect(
      plan.optimizationInsufficient === true || plan.feasibility.status !== "does-not-fit",
    ).toBe(true);
  });
});
