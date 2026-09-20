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
 *   task effort, per-phase cost, minimum viable budget, confidence,
 *   recommended maximum, reserve, feasibility, model suitability,
 *   scope reduction, model recommendation, comparison, execution plan
 *
 * The model is never asked for money. It supplies workload signals — effort,
 * per-phase tokens, iteration ranges — and Promgent turns those into CREDIT
 * figures using model pricing. That keeps the numbers reproducible, and it
 * means a complex task cannot collapse into a single-digit estimate just
 * because its complexity label is generic.
 *
 * If the combined call cannot be used — AGENTFUND_AI_COMBINED=0, or the
 * response fails validation — the pipeline falls back to the two-call path
 * (analyze, then write). The fallback costs one extra round trip, but only for
 * the models that need it, so no one pays for it by default.
 */

import { AUTO_MODEL_ID, MODELS, findModelOrThrow } from "@/data/models";
import { generatePlan } from "@/lib/ai/combined";
import { aiCombinedEnabled } from "@/lib/ai/env";
import { analyzeTask } from "@/lib/ai/provider";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { generatePrompt } from "@/lib/ai/promptGenerator";
import { answerScopeSignal, resolveAnswers, answersUsed } from "@/lib/clarifier";
import {
  WEIGHT_VALUE,
  buildEnrichedTask,
  describeEnrichedTask,
  requirementWorkload,
  type EnrichedTask,
  type ResolvedRequirement,
} from "@/lib/clarifier/enrichedTask";
import { allocatePhaseCosts, estimateCost, formatRange } from "@/lib/estimator/costEstimator";
import { evaluateFeasibility, planReserve } from "@/lib/estimator/feasibilityEngine";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";
import { evaluateSuitability, selectCapableModel } from "@/lib/models/suitability";
import { deriveRequirementProfile } from "@/lib/models/capabilities";
import { buildComparison, selectModel } from "@/lib/models/modelSelector";
import {
  applyScopeReduction,
  optimizeScopeForBudget,
} from "@/lib/scopeOptimizer/scopeOptimizer";
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
  /**
   * True when the user was warned their model is not recommended and chose to
   * keep it anyway, so the UI can show the override honestly.
   */
  keepSelectedModel?: boolean;
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
/**
 * Estimates the scope locally from the enriched task and defers work until the
 * budget is met. Used only to give the prompt writer the resolved scope in the
 * same call; the plan's authoritative scope is still computed after analysis.
 */
function preResolveScope(input: {
  enrichedTask: EnrichedTask;
  budget: number;
  optimization: OptimizationPreference;
  modelId: string;
}): { included: string[]; deferred: string[] } | null {
  const { enrichedTask, budget, optimization, modelId } = input;

  let model: ModelConfig;
  try {
    model = findModelOrThrow(modelId);
  } catch {
    return null;
  }

  const included: string[] = [];
  const deferred: string[] = [];
  const active = [...enrichedTask.resolvedRequirements];

  const estimateFor = (requirements: ResolvedRequirement[]): number =>
    estimateCost({
      analysis: {
        ...heuristicAnalyze(enrichedTask.originalTask),
        effort: undefined,
      },
      model,
      preference: optimization,
      taskDescription: enrichedTask.originalTask,
      answerMultiplier: 1 + requirements.length * 0.08,
      addedRequirements: requirements.length,
    }).recommendedMaximum;

  // Defer the heaviest requirements first while the estimate exceeds budget.
  for (let pass = 0; pass < 8 && estimateFor(active) > budget; pass += 1) {
    if (active.length === 0) break;
    const heaviest = active.reduce((worst, current) =>
      WEIGHT_VALUE[current.weight] > WEIGHT_VALUE[worst.weight] ? current : worst,
    );
    active.splice(active.indexOf(heaviest), 1);
    deferred.push(heaviest.name);
  }

  for (const requirement of active) included.push(requirement.name);
  if (deferred.length === 0) return null;

  return { included, deferred };
}

export async function buildPlanWithMetrics(request: PlanRequest): Promise<PlanBuildResult> {
  const {
    taskDescription,
    modelId,
    optimization,
    budget,
    applyOptimizedScope = false,
    clarifyingQuestions = [],
    clarifyingResponses = {},
    keepSelectedModel = false,
  } = request;

  const started = Date.now();

  const clarifyingAnswers: ClarifyingAnswer[] = resolveAnswers(
    clarifyingQuestions,
    clarifyingResponses,
  );
  const usedAnswers = answersUsed(clarifyingAnswers);

  /**
   * How the answers change the workload.
   *
   * Answers are not just prompt colour: confirming authentication, multi-user
   * support or production deployment adds real components, so the estimate must
   * rise. Computed once and passed to every cost call in this pipeline.
   */
  const answerSignal = answerScopeSignal(clarifyingAnswers);

  /**
   * The enriched task: one canonical representation of intent.
   *
   * Built once, before any LLM call, from the original wording plus the
   * answers. Every later stage — analyzer, estimator, suitability, scope
   * optimizer and prompt writer — reads from this, so they cannot disagree.
   */
  const enrichedTask = buildEnrichedTask({
    taskDescription,
    taskType: heuristicAnalyze(taskDescription).taskType,
    answers: clarifyingAnswers,
  });

  /**
   * Pre-call scope resolution.
   *
   * The prompt is written once, by the same call that produces the analysis. If
   * the user has accepted an optimized scope, the writer must know about it
   * up front — otherwise the prompt describes the original request while the UI
   * shows a reduced one.
   *
   * This estimates from the enriched task's own resolved requirements (no LLM
   * call), defers the heaviest non-essential ones while over budget, and feeds
   * the result into the prompt. The authoritative post-analysis scope is still
   * computed after the call; this one exists so the two cannot contradict.
   */
  const preResolvedScope = applyOptimizedScope
    ? preResolveScope({
        enrichedTask,
        budget,
        optimization,
        modelId: modelId === AUTO_MODEL_ID ? "claude-sonnet" : modelId,
      })
    : null;

  const autoSelected = modelId === AUTO_MODEL_ID;

  /**
   * Auto model resolution, done up front from capability requirements.
   *
   * This is a purely local decision: it needs what the task DEMANDS, which the
   * enriched task already describes, not the LLM's narrative analysis. Resolving
   * it here means the combined call always writes for a concrete model.
   */
  const autoRequirementProfile = deriveRequirementProfile({
    taskType: enrichedTask.taskType,
    complexity: "high",
    effortScore: requirementWorkload(enrichedTask) * 4,
  });
  const preResolvedAutoModel = autoSelected
    ? (selectCapableModel(autoRequirementProfile, MODELS, optimization) ?? null)
    : null;


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
    /**
     * Auto mode picks the cheapest model that is sufficiently capable, using
     * the capability profile rather than price alone. Price decides between
     * models that both clear the bar.
     */
    let recommendation: PlanResult["recommendation"] = null;
    let resolvedModelId = modelId;

    if (autoSelected) {
      const effort = resolveTaskEffort({
        analysis,
        taskDescription,
        answerMultiplier: answerSignal.effortMultiplier,
        addedRequirements: answerSignal.addedRequirements,
      });
      const profile =
        analysis.requirementProfile ??
        deriveRequirementProfile({
          taskType: analysis.taskType,
          complexity: analysis.complexity,
          effortScore: effort.score,
        });

      const capable = selectCapableModel(profile, MODELS, optimization);
      if (capable) {
        resolvedModelId = capable.id;
        recommendation = {
          modelId: capable.id,
          displayName: capable.displayName,
          estimated: 0,
          reasons: ["Cheapest model that meets this task's capability requirements."],
        };
      } else {
        const fallback = selectModel(analysis, budget, optimization, taskDescription);
        if (fallback) {
          resolvedModelId = String(fallback.modelId);
          recommendation = fallback;
        }
      }
    }

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
      /**
       * The target model must be resolved BEFORE the prompt is written.
       *
       * Auto previously fell back to a neutral placeholder profile at this
       * point, so the prompt was written generically and the real model was
       * chosen only afterwards — the prompt could not be specialized for the
       * model it would actually run on.
       *
       * On the two-call route the model is resolved after analysis and before
       * generation (below). The combined route returns analysis and prompt in
       * one response, so the model cannot be resolved in between; in that case
       * Auto is resolved from the enriched task up front, before the call, and
       * only falls back to the neutral profile when no capable model could be
       * determined at all.
       */
      const target = autoSelected
        ? (preResolvedAutoModel ?? neutralTargetModel())
        : findModelOrThrow(modelId);
      try {
        const combined = await generatePlan({
          // The enriched description leads with the user's own words, then adds
          // the resolved requirements the estimator also uses — so the
          // analysis and the estimate are derived from the same input.
          taskDescription: describeEnrichedTask(enrichedTask),
          targetModel: target,
          optimization,
          budget,
          clarifyingAnswers,
          // When the user has accepted an optimized scope, the prompt must be
          // written for that scope, not the original request.
          resolvedScope: preResolvedScope
            ? { included: preResolvedScope.included, deferred: preResolvedScope.deferred }
            : undefined,
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
    const preliminary = estimateCost({
      analysis: firstAnalysis,
      model,
      preference: optimization,
      taskDescription,
      answerMultiplier: answerSignal.effortMultiplier,
      addedRequirements: answerSignal.addedRequirements,
    });
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

  const preliminary = estimateCost({
    analysis: rawAnalysis,
    model,
    preference: optimization,
    taskDescription,
  });
  const needsOptimization = preliminary.recommendedMaximum > budget || preliminary.maximum > budget;

  let analysis = rawAnalysis;
  let optimizedScope: PlanResult["optimizedScope"] = null;
  let scopeApplied = false;
  /** True when every safe reduction was applied and the budget is still short. */
  let optimizationStillInsufficient = false;

  if (needsOptimization) {
    /**
     * Iterative optimization: propose, re-estimate, repeat.
     *
     * Removing a fixed fraction of optional work does not reliably land inside
     * the budget — it can leave the task far over, or cut far more than needed.
     * Each pass re-estimates and stops as soon as the budget is actually met,
     * so the returned scope is one that has been verified to fit.
     */
    /**
     * Optimize with the REAL estimator, not a proxy.
     *
     * The optimizer re-estimates after every deferral using the same cost
     * engine the final number comes from, so the returned scope is one that has
     * been verified to fit rather than one that merely looks smaller.
     */
    /**
     * The requirement units under consideration, and the scale they imply.
     *
     * The estimate must actually respond to which requirements are kept — if
     * it returned the same number regardless, the optimizer could not tell a
     * helpful deferral from a useless one and would stop immediately.
     */
    const scopeRequirements = enrichedTask.resolvedRequirements.map((requirement) => ({
      name: requirement.name,
      weight: requirement.weight,
      essential: false,
    }));

    const estimateForScope = (includedNames: string[]) => {
      const kept = scopeRequirements.filter((requirement) =>
        includedNames.includes(requirement.name),
      );
      // Requirements kept drive the workload directly, so the estimate falls as
      // items are deferred. Phase names are always present and never deferred.
      const retainedRatio =
        scopeRequirements.length > 0 ? kept.length / scopeRequirements.length : 1;

      return estimateCost({
        analysis: applyScopeReduction(
          rawAnalysis,
          { included: includedNames, deferred: [], simplified: [], rationale: "" },
          taskDescription,
        ),
        model,
        preference: optimization,
        taskDescription,
        answerMultiplier: 1 + (answerSignal.effortMultiplier - 1) * retainedRatio,
        addedRequirements: kept.length,
      }).recommendedMaximum;
    };

    const optimized = optimizeScopeForBudget({
      taskDescription,
      analysis: rawAnalysis,
      budget,
      estimate: estimateForScope,
      // Defer real requirements, not generic phases: "payments" and
      // "analytics" are deferrable, "Execution" is not.
      requirements: scopeRequirements,
    });

    optimizedScope = optimized.scope;
    // Whether the budget was actually met is part of the result, so the UI can
    // say "still insufficient" instead of implying feasibility.
    optimizationStillInsufficient = optimized.stillInsufficient;
    if (applyOptimizedScope && optimized.scope) {
      analysis = applyScopeReduction(rawAnalysis, optimized.scope, taskDescription);
      scopeApplied = true;
    }
  }

  const cost = estimateCost({
    analysis,
    model,
    preference: optimization,
    taskDescription,
    answerMultiplier: answerSignal.effortMultiplier,
    addedRequirements: answerSignal.addedRequirements,
  });
  const optimizedEstimate = optimizedScope
    ? estimateCost({
        analysis: applyScopeReduction(rawAnalysis, optimizedScope, taskDescription),
        model,
        preference: optimization,
        taskDescription,
      })
    : null;

  const feasibility = evaluateFeasibility({
    userBudget: budget,
    estimatedMinimum: cost.minimum,
    estimatedMaximum: cost.maximum,
    minimumViable: cost.minimumViable,
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

  /**
   * Model suitability, computed independently from budget feasibility:
   * "can this model do it" and "can the user afford it" are separate verdicts,
   * so the UI can say whether to switch model, raise budget, or both.
   */
  const suitability = evaluateSuitability({
    model,
    analysis: analysisWithCosts,
    taskDescription,
    candidates: MODELS,
    explicit: !autoSelected,
    overridden: keepSelectedModel === true,
    currentEstimate: cost.maximum,
  });

  // Cost delta for switching to the suggested model, when one exists.
  if (suitability.suggestedModelId) {
    try {
      const suggested = findModelOrThrow(suitability.suggestedModelId);
      const suggestedCost = estimateCost({
        analysis,
        model: suggested,
        preference: optimization,
        taskDescription,
        answerMultiplier: answerSignal.effortMultiplier,
      });
      suitability.suggestedDelta = Math.round((suggestedCost.maximum - cost.maximum) * 100) / 100;
    } catch {
      // An unknown suggestion must never break the plan.
    }
  }

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
    /** Concrete resolved model when Auto was used, for the UI to show. */
    resolvedModelId: autoSelected ? model.id : undefined,
    resolvedModelReason: autoSelected
      ? (recommendation?.reasons[0] ?? "Cheapest model that meets this task's capability requirements.")
      : undefined,
    /** True when even the safest scope reduction leaves the budget short. */
    optimizationInsufficient: optimizationStillInsufficient,
    suitability,
    comparison: buildComparison(
      rawAnalysis,
      optimization,
      recommendation ?? {
        modelId: model.id,
        displayName: model.displayName,
        estimated: cost.maximum,
        reasons: [],
      },
      // The ORIGINAL request, not the summary: pricing must reflect the real scope.
      taskDescription,
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