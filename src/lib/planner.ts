/**
 * Orchestrates the planning pipeline, shared by the frontend and the backend.
 *
 * LLM BUDGET: the normal path is ONE call. `./ai/combined` asks the internal
 * model for the task analysis and the finished prompt in a single structured
 * response, which removes one entire provider round trip compared with calling
 * for each half separately.
 *
 * Everything after that call is LOCAL and deterministic:
 *
 *   cost estimate, recommended maximum, reserve, feasibility,
 *   scope reduction, model recommendation, comparison, execution plan
 *
 * The model is never asked for money. It supplies token estimates and scope
 * judgements; Promgent turns those into CREDIT figures using model metadata.
 * That keeps the product's numbers reproducible and auditable.
 *
 * If the combined call cannot be used — AGENTFUND_AI_COMBINED=0, or the
 * response fails validation — the pipeline falls back to the two-call path
 * (analyze, then write). The fallback costs one extra round trip, but only for
 * the models that need it, so no one pays for it by default.
 */

import { AUTO_MODEL_ID, findModelOrThrow } from "@/data/models";
import { generatePlan } from "@/lib/ai/combined";
import { aiCombinedEnabled } from "@/lib/ai/env";
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

/** How the plan was produced, so latency and behaviour can be attributed. */
export type PlanRoute = "combined" | "two-call";

export interface PlanBuildResult {
  plan: PlanResult;
  route: PlanRoute;
  requestId?: string;
  providerDurationMs?: number;
  /** Time spent inside LLM calls, across whichever route was used. */
  llmDurationMs: number;
  /** Time spent parsing/validating model output. */
  parseDurationMs: number;
  /** Time spent in local calculations. */
  localDurationMs: number;
  /** LLM requests actually sent, summed across the route. */
  llmCalls: number;
  /** Retries beyond the first attempt, summed across the route. */
  retryCount: number;
}

/** Stand-in target description for Auto: "auto" is not a model id, and naming
 * one here would bake a specific model into the prompt. */
function neutralTargetModel(): ModelConfig {
  return {
    id: "auto",
    displayName: "the recommended model",
    provider: "unspecified",
    capabilityTier: "standard",
    inputPrice: 0,
    outputPrice: 0,
    codingCapability: 0,
    reasoningCapability: 0,
    researchCapability: 0,
    contextWindow: 32000,
  };
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
  return (await buildPlanWithMetrics(request)).plan;
}

/**
 * Builds a plan and reports how it was produced.
 *
 * The timings here are what make the request diagnosable: LLM time, parse time
 * and local time are tracked separately, so a slow request can be attributed to
 * the provider rather than guessed at.
 */
export async function buildPlanWithMetrics(request: PlanRequest): Promise<PlanBuildResult> {
  const {
    taskDescription,
    modelId,
    optimization,
    budget,
    applyOptimizedScope = false,
    clarifyingQuestions = [],
    clarifyingResponses = {},
  } = request;

  const started = Date.now();

  const clarifyingAnswers: ClarifyingAnswer[] = resolveAnswers(
    clarifyingQuestions,
    clarifyingResponses,
  );
  const usedAnswers = answersUsed(clarifyingAnswers);

  const autoSelected = modelId === AUTO_MODEL_ID;

  /**
   * Resolve the target model.
   *
   * Auto needs an analysis first, so on the two-call route it is resolved after
   * analysis. On the combined route the model is unknown until the response
   * arrives, so Auto is resolved from that analysis and the prompt is already
   * written for the tier of whatever was chosen — which is why the combined
   * prompt asks for phrasing suited to the target's capability tier and the
   * fallback path is used when an explicit Auto selection needs precision.
   */
  async function resolveTargetModel(analysis: TaskAnalysis): Promise<{
    model: ModelConfig;
    recommendation: PlanResult["recommendation"];
  }> {
    const recommendation = autoSelected ? selectModel(analysis, budget, optimization) : null;
    const resolvedModelId = autoSelected ? String(recommendation?.modelId) : modelId;
    return { model: findModelOrThrow(resolvedModelId), recommendation };
  }

  let route: PlanRoute = "combined";
  let llmDurationMs = 0;
  let parseDurationMs = 0;
  let llmCalls = 0;
  let retryCount = 0;
  let agentModel: string | undefined;
  let requestId: string | undefined;
  let providerDurationMs: number | undefined;

  /**
   * Produces the analysis and the prompt, using ONE call when possible.
   *
   * Returns both values on every path, so the rest of the pipeline never has to
   * reason about which route produced them.
   */
  async function produceAnalysisAndPrompt(): Promise<{ analysis: TaskAnalysis; prompt: string }> {
    if (aiCombinedEnabled()) {
      // Auto is resolved after this call, so the writer is told the capability
      // tier of the explicit choice, or a neutral tier when the user picked
      // Auto. The local recommendation still decides the target model.
      const target = autoSelected ? neutralTargetModel() : findModelOrThrow(modelId);
      try {
        const combined = await generatePlan({
          taskDescription,
          targetModel: target,
          optimization,
          budget,
          clarifyingAnswers,
        });
        route = "combined";
        agentModel = combined.model;
        requestId = combined.requestId;
        providerDurationMs = combined.providerDurationMs;
        llmDurationMs += combined.durationMs;
        llmCalls += 1;
        retryCount += Math.max(0, combined.attemptCount - 1);
        return { analysis: combined.analysis, prompt: combined.prompt };
      } catch (error) {
        // Fall through to two calls rather than failing outright: a model that
        // cannot return both halves together should still be usable. If the
        // fallback also fails, its error is the freshest and most relevant.
        route = "two-call";
      }
    } else {
      route = "two-call";
    }

    const parsedStart = Date.now();
    const analysisResult = await analyzeTask(taskDescription);
    parseDurationMs += Date.now() - parsedStart;
    const firstAnalysis = analysisResult.analysis;
    agentModel = analysisResult.model;
    requestId = analysisResult.requestId;
    providerDurationMs = analysisResult.providerDurationMs;
    llmDurationMs += analysisResult.durationMs;
    llmCalls += 1;
    retryCount += Math.max(0, analysisResult.attemptCount - 1);

    const { model } = await resolveTargetModel(firstAnalysis);
    const preliminary = estimateCost(firstAnalysis, model, optimization);
    const generated = await generatePrompt({
      taskDescription,
      analysis: { ...firstAnalysis, phases: allocatePhaseCosts(firstAnalysis, preliminary) },
      targetModel: model,
      optimization,
      budget,
      cost: {
        minimum: preliminary.minimum,
        maximum: preliminary.maximum,
        recommendedMaximum: preliminary.recommendedMaximum,
      },
      clarifyingAnswers,
    });
    llmDurationMs += generated.durationMs;
    providerDurationMs = generated.providerDurationMs ?? providerDurationMs;
    llmCalls += 1;
    retryCount += Math.max(0, generated.attemptCount - 1);
    return { analysis: firstAnalysis, prompt: generated.prompt };
  }

  const { analysis: rawAnalysis, prompt } = await produceAnalysisAndPrompt();

  // Everything from here is local: no LLM work, only deterministic maths.
  const localStart = Date.now();

  const { model, recommendation } = await resolveTargetModel(rawAnalysis);

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

  const localDurationMs = Date.now() - localStart;

  const plan: PlanResult = {
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
    prompt,
    // Which internal model produced this plan. Diagnostic only: it is not the
    // user's target model, and it never contains a credential.
    agentModel,
    analysisDurationMs: llmDurationMs,
    promptDurationMs: 0,
    // Route and latency breakdown. Diagnostic only, but it is what lets a slow
    // request be attributed to the provider or to Promgent without guessing.
    route,
    requestId,
    llmCalls,
    retryCount,
    totalDurationMs: Date.now() - started,
    llmDurationMs,
    providerDurationMs,
    parseDurationMs,
    localDurationMs,
  };

  return {
    plan,
    route,
    llmDurationMs,
    parseDurationMs,
    localDurationMs,
    llmCalls,
    retryCount,
    requestId,
    providerDurationMs,
  };
}

export function planCostLabel(plan: PlanResult): string {
  return formatRange(plan.cost.minimum, plan.cost.maximum);
}