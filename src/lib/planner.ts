import { AUTO_MODEL_ID, findModelOrThrow } from "@/data/models";
import { analyzeTask } from "@/lib/ai/provider";
import { generatePrompt } from "@/lib/ai/promptGenerator";
import { resolveAnswers, answersUsed } from "@/lib/clarifier";
import { allocatePhaseCosts, estimateCost, formatRange } from "@/lib/estimator/costEstimator";
import { evaluateFeasibility, planReserve } from "@/lib/estimator/feasibilityEngine";
import { buildComparison, selectModel } from "@/lib/models/modelSelector";
import { applyScopeReduction, optimizeScope } from "@/lib/scopeOptimizer/scopeOptimizer";
import type {
  ClarifyingAnswer,
  ClarifyingQuestion,
  ExecutionPlan,
  ModelConfig,
  OptimizationPreference,
  PlanResult,
  TaskAnalysis,
} from "@/types";

export interface PlanRequest {
  taskDescription: string;
  modelId: string;
  optimization: OptimizationPreference;
  budget: number;
  applyOptimizedScope?: boolean;
  /** Questions that were shown to the user, if the clarifying step ran. */
  clarifyingQuestions?: ClarifyingQuestion[];
  /** Raw user answers keyed by question id. Missing or blank means skipped. */
  clarifyingResponses?: Record<string, string>;
}

function executionPlanFor(
  analysis: TaskAnalysis,
  optimization: OptimizationPreference,
): ExecutionPlan {
  const steps = analysis.phases.map((p, i) => `${i + 1}. ${p.name} - ${p.description}`);
  const strategy =
    optimization === "minimize-cost"
      ? "Single focused pass with tight scope, then one targeted correction cycle."
      : optimization === "maximum-quality"
        ? "Full pass with explicit validation, then revision cycles until acceptance criteria pass."
        : "Structured pass with validation and one revision cycle held in reserve.";

  return {
    strategy,
    steps,
    validationApproach:
      "Check the output against every requirement before finishing, and fix only failing parts.",
    revisionPolicy: "Use targeted corrections instead of full rewrites.",
  };
}

export async function buildPlan(request: PlanRequest): Promise<PlanResult> {
  const {
    taskDescription,
    modelId,
    optimization,
    budget,
    applyOptimizedScope = false,
    clarifyingQuestions = [],
    clarifyingResponses = {},
  } = request;

  // Throws a structured AiError if the model is unconfigured or fails: the
  // pipeline never continues with a substituted analysis.
  // This is LLM call #1 of the two a completed task makes.
  const {
    analysis: rawAnalysis,
    model: agentModel,
    durationMs: analysisDurationMs,
  } = await analyzeTask(taskDescription);

  const clarifyingAnswers: ClarifyingAnswer[] = resolveAnswers(
    clarifyingQuestions,
    clarifyingResponses,
  );
  const usedAnswers = answersUsed(clarifyingAnswers);

  const autoSelected = modelId === AUTO_MODEL_ID;
  const recommendation = autoSelected ? selectModel(rawAnalysis, budget, optimization) : null;
  const resolvedModelId = autoSelected ? String(recommendation?.modelId) : modelId;
  const model: ModelConfig = findModelOrThrow(resolvedModelId);

  const preliminary = estimateCost(rawAnalysis, model, optimization);
  const needsOptimization = preliminary.recommendedMaximum > budget || preliminary.maximum > budget;

  let analysis = rawAnalysis;
  let optimizedScope: PlanResult["optimizedScope"] = null;
  let scopeApplied = false;

  if (needsOptimization) {
    const candidate = optimizeScope(rawAnalysis, budget);
    optimizedScope = candidate;
    if (applyOptimizedScope) {
      analysis = applyScopeReduction(rawAnalysis, candidate);
      scopeApplied = true;
    }
  }

  const cost = estimateCost(analysis, model, optimization);
  const optimizedEstimate = optimizedScope
    ? estimateCost(applyScopeReduction(rawAnalysis, optimizedScope), model, optimization)
    : null;

  const feasibility = evaluateFeasibility({
    userBudget: budget,
    estimatedMinimum: cost.minimum,
    estimatedMaximum: cost.maximum,
    recommendedMaximum: cost.recommendedMaximum,
    optimized:
      scopeApplied && optimizedEstimate
        ? {
            minimum: optimizedEstimate.minimum,
            maximum: optimizedEstimate.maximum,
            recommendedMaximum: optimizedEstimate.recommendedMaximum,
          }
        : null,
  });

  const reserve = planReserve(budget, cost.maximum, feasibility.status);

  const analysisWithCosts: TaskAnalysis = {
    ...analysis,
    phases: allocatePhaseCosts(analysis, cost),
  };

  // LLM call #2, and the last one. Everything between the two calls is local
  // calculation: cost, feasibility, scope and model recommendation cost no LLM
  // time at all.
  const generated = await generatePrompt({
    taskDescription,
    analysis: analysisWithCosts,
    targetModel: model,
    optimization,
    budget,
    cost: {
      minimum: cost.minimum,
      maximum: cost.maximum,
      recommendedMaximum: cost.recommendedMaximum,
    },
    clarifyingAnswers,
  });

  return {
    id: `plan_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    taskDescription,
    analysis: analysisWithCosts,
    modelId: model.id,
    autoSelected,
    optimization,
    budget,
    cost,
    reserve,
    feasibility,
    optimizedScope,
    scopeApplied,
    recommendation,
    comparison: buildComparison(
      rawAnalysis,
      optimization,
      recommendation ?? {
        modelId: model.id,
        displayName: model.displayName,
        estimated: cost.maximum,
        reasons: [],
      },
    ),
    executionPlan: executionPlanFor(analysisWithCosts, optimization),
    clarifyingAnswers,
    answersUsed: usedAnswers,
    promptSource: "ai",
    prompt: generated.prompt,
    // Which internal model produced this plan. Diagnostic only: it is not the
    // user's target model, and it never contains a credential.
    agentModel,
    // Per-stage timings, so a slow request can be attributed to the stage that
    // caused it rather than only to the request as a whole.
    analysisDurationMs,
    promptDurationMs: generated.durationMs,
  };
}

export function planCostLabel(plan: PlanResult): string {
  return formatRange(plan.cost.minimum, plan.cost.maximum);
}