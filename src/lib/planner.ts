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
import { AiError } from "@/lib/ai/errors";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { generatePrompt } from "@/lib/ai/promptGenerator";
import { answerScopeSignal, resolveAnswers, answersUsed } from "@/lib/clarifier";
import { buildEnrichedTask, describeEnrichedTask } from "@/lib/clarifier/enrichedTask";
import { allocatePhaseCosts, estimateCost, formatRange } from "@/lib/estimator/costEstimator";
import { evaluateFeasibility, planReserve } from "@/lib/estimator/feasibilityEngine";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";
import { evaluateSuitability, selectCapableModel } from "@/lib/models/suitability";
import { deriveRequirementProfile } from "@/lib/models/capabilities";
import { buildComparison, selectModel } from "@/lib/models/modelSelector";
import { createCanonicalEstimator } from "@/lib/scopeOptimizer/canonicalEstimator";
import {
  buildFinalScope,
  excludedRequirements,
  includedRequirements,
  optimizeFinalScope,
} from "@/lib/scopeOptimizer/finalScope";
import type {
  ReferenceAnalysis,
  ReferenceInput,
  ReferenceWorkload,
} from "@/lib/reference/types";
import { NO_REFERENCE_WORKLOAD } from "@/lib/reference/types";
import { referenceWorkload } from "@/lib/reference/workload";
import { describeReferenceForPrompt } from "@/lib/reference/referenceAnalyzer";
import type { FinalScope } from "@/types";
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
  /**
   * Optional image/website references. Omit entirely for text-only requests:
   * `[]` and `undefined` are both valid, and neither triggers any reference
   * processing.
   */
  references?: ReferenceInput[];
  /**
   * Pre-computed reference understanding, when the caller analyzed references
   * before planning. Supplying it means the analysis is done exactly once and
   * the same object reaches cost, scope and prompt.
   */
  referenceAnalysis?: ReferenceAnalysis[];
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
 * Enforces the invariants that make a plan internally consistent.
 *
 * Throws rather than repairing: silently "fixing" a mismatch after the prompt
 * has been written would return a prompt that does not match the plan.
 */
function assertPlanConsistency(input: {
  resolvedModelId: string;
  promptModelId: string;
  costModelId: string;
  finalScope: FinalScope;
  /** The scope the final estimate was computed from. */
  estimateScope: FinalScope;
  /** The scope the prompt was written for. */
  promptScope: FinalScope;
  /** Re-derives the cost of a scope through the canonical estimator. */
  reestimate: (scope: FinalScope) => number;
  /** The number the plan reports. */
  reportedEstimate: number;
  prompt: string;
  autoSelected: boolean;
}): void {
  const {
    resolvedModelId,
    promptModelId,
    costModelId,
    finalScope,
    estimateScope,
    promptScope,
    reestimate,
    reportedEstimate,
    prompt,
    autoSelected,
  } = input;

  const fail = (message: string): never => {
    throw new AiError("AI_VALIDATION_FAILED", `Internal planning inconsistency: ${message}`);
  };

  // 1. One model everywhere: resolved === prompt === cost.
  if (resolvedModelId !== promptModelId || resolvedModelId !== costModelId) {
    fail(
      `model mismatch (resolved=${resolvedModelId}, prompt=${promptModelId}, cost=${costModelId}).`,
    );
  }

  // 2. Auto must resolve to a concrete model, never "auto".
  if (autoSelected && (!resolvedModelId || resolvedModelId === "auto")) {
    fail("Auto did not resolve to a concrete model.");
  }

  // 3. One scope everywhere: final === estimated === prompted.
  const ids = (scope: FinalScope) => [...scope.includedIds].sort().join("|");
  if (ids(finalScope) !== ids(estimateScope) || ids(finalScope) !== ids(promptScope)) {
    fail("the final scope, the estimated scope and the prompted scope are not the same scope.");
  }

  // 4. The reported estimate is the canonical estimate OF THAT SCOPE.
  const recomputed = reestimate(finalScope);
  if (Math.abs(recomputed - reportedEstimate) > 0.01) {
    fail(
      `the reported estimate (${reportedEstimate}) is not the canonical estimate of the ` +
        `final scope (${recomputed}).`,
    );
  }

  // 5. Core REQUIREMENTS must survive optimization. (Generic phases are
  //    workflow scaffolding, not the user's requirements, so they are excluded
  //    from this check.)
  const included = new Set(finalScope.includedIds);
  const droppedCore = finalScope.requirements.filter(
    (unit) => unit.core && unit.source === "task" && !included.has(unit.id),
  );
  if (droppedCore.length > 0) {
    fail(`core requirement(s) removed (${droppedCore.map((unit) => unit.name).join(", ")}).`);
  }

  // 6. Deferred work must not be requested in the prompt.
  const excluded = new Set(finalScope.excludedIds);
  const lower = prompt.toLowerCase();
  const leaked = finalScope.requirements.filter(
    (unit) => excluded.has(unit.id) && lower.includes(unit.name.toLowerCase()),
  );
  if (leaked.length > 0) {
    fail(
      `deferred requirement(s) present in the prompt (${leaked.map((unit) => unit.name).join(", ")}).`,
    );
  }
}

export async function buildPlanWithMetrics(request: PlanRequest): Promise<PlanBuildResult> {
  const {
    taskDescription,
    modelId,
    optimization,
    budget,
    applyOptimizedScope = false,
    references = [],
    referenceAnalysis = [],
    clarifyingQuestions = [],
    clarifyingResponses = {},
    keepSelectedModel = false,
  } = request;

  const started = Date.now();

  /**
   * The reference analyses for this request.
   *
   * Computed once by the caller (or empty for text-only requests) and read by
   * every stage that needs it — estimation, scope and the prompt — so no stage
   * can end up with a different understanding of the same reference.
   */
  const referenceAnalyses: ReferenceAnalysis[] = Array.isArray(referenceAnalysis)
    ? referenceAnalysis
    : [];
  const referenceSignal: ReferenceWorkload = referenceAnalyses.length
    ? referenceWorkload(referenceAnalyses)
    : NO_REFERENCE_WORKLOAD;

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

  const autoSelected = modelId === AUTO_MODEL_ID;

  /**
   * THE ONE authoritative model resolution for this request.
   *
   * There is exactly one decision, memoised here and read by every later
   * stage: prompt writer, canonical estimator, feasibility, suitability and
   * the final consistency check.
   *
   * Both routes obey this contract. The combined route returns analysis and
   * prompt in one response, so the model cannot be resolved in between; it is
   * therefore resolved BEFORE the call. Either way it happens once, and the
   * prompt is written for the exact model the plan reports.
   *
   * Auto is always resolved to a concrete model — never a neutral placeholder
   * and never the literal id "auto".
   */
  let resolvedModel: {
    model: ModelConfig;
    recommendation: PlanResult["recommendation"];
  } | null = null;

  async function resolveTargetModel(analysis: TaskAnalysis): Promise<{
    model: ModelConfig;
    recommendation: PlanResult["recommendation"];
  }> {
    if (resolvedModel) return resolvedModel;
    resolvedModel = await computeTargetModel(analysis);
    return resolvedModel;
  }

  async function computeTargetModel(analysis: TaskAnalysis): Promise<{
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

  /**
   * THE PLANNING CONTEXT: target model and canonical scope, decided ONCE,
   * before any prompt is written.
   *
   * Both come from the enriched task and the local heuristic analysis, not
   * from the LLM's narrative. On the combined route the LLM's analysis arrives
   * in the same response as the prompt, so anything decided afterwards could
   * not reach the writer — deciding up front is what makes "the prompt is
   * written for the scope and model the plan reports" actually true.
   *
   * Requirements are deterministic from the user's own words plus their
   * answers, so the scope never depends on the LLM at all.
   */
  const heuristicAnalysis = heuristicAnalyze(describeEnrichedTask(enrichedTask));
  const { model, recommendation } = await resolveTargetModel(heuristicAnalysis);

  /**
   * References add planning workload.
   *
   * Combined with the clarifying-answer signal into the SAME two inputs the
   * estimator already accepts, so the deterministic cost engine is extended
   * rather than duplicated or bypassed.
   */
  const effortMultiplier =
    answerSignal.effortMultiplier * referenceSignal.effortMultiplier;
  const addedRequirements =
    answerSignal.addedRequirements + referenceSignal.addedRequirements;

  const baseEffort = resolveTaskEffort({
    analysis: heuristicAnalysis,
    taskDescription,
    answerMultiplier: effortMultiplier,
    addedRequirements,
  });

  /** INITIAL SCOPE — requirements with stable ids, nothing deferred yet. */
  const initialScope: FinalScope = buildFinalScope({
    analysis: heuristicAnalysis,
    requirements: enrichedTask.resolvedRequirements.map((requirement) => ({
      name: requirement.name,
      weight: requirement.weight,
    })),
  });

  /** THE canonical estimator, shared by the optimizer and the final estimate. */
  const canonical = createCanonicalEstimator({
    analysis: heuristicAnalysis,
    model,
    optimization,
    taskDescription,
    answerMultiplier: effortMultiplier,
    addedRequirements,
    baseEffort,
    fullRequirementCount: initialScope.requirements.length,
  });

  /** CANONICAL ESTIMATE of the initial scope, and the budget check. */
  const initialCost = canonical.estimateFull(initialScope);
  const needsOptimization =
    initialCost.recommendedMaximum > budget || initialCost.maximum > budget;

  /**
   * OPTIMIZE THE SAME SCOPE — the only optimization engine. It re-estimates
   * every candidate with the canonical estimator, respects core work and
   * dependency safety, is bounded and deterministic, and never uses a
   * "drop half the optional items" strategy.
   */
  const optimized = needsOptimization
    ? optimizeFinalScope({ scope: initialScope, budget, estimate: canonical.estimate })
    : null;

  /** True when every safe reduction was applied and the budget is still short. */
  const optimizationStillInsufficient = optimized
    ? !optimized.withinBudget
    : initialCost.recommendedMaximum > budget;

  /**
   * THE FINAL CANONICAL SCOPE — the single source of truth.
   *
   * The reduction the user accepted becomes the scope; otherwise the full
   * scope stands. Either way this one object is what the prompt is written
   * for, what the final estimate is computed from, and what the plan reports.
   */
  const finalScope: FinalScope =
    applyOptimizedScope && optimized ? optimized.finalScope : initialScope;

  /** Whether the reduced scope was actually applied to the plan's numbers. */
  const scopeApplied =
    applyOptimizedScope && optimized !== null && finalScope.reductions.length > 0;

  /** FINAL CANONICAL ESTIMATE of that scope, with the resolved model. */
  const cost = canonical.estimateFull(finalScope);

  const optimizedEstimate = optimized ? canonical.estimateFull(finalScope) : null;

  /**
   * The reference brief given to the prompt writer.
   *
   * Built once from the same analyses the estimator used, so the prompt cannot
   * describe a different reference than the plan costed. Empty for text-only
   * requests, in which case no reference block is added at all.
   */
  const referenceBrief = referenceAnalyses.length
    ? referenceAnalyses.map(describeReferenceForPrompt).join("\n\n")
    : "";

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
      /**
       * The target model and the final scope were both resolved above, before
       * this call. The writer therefore receives the exact model the plan will
       * report and the exact scope the plan will cost — never a placeholder.
       */
      try {
        const combined = await generatePlan({
          // The enriched description leads with the user's own words, then adds
          // the resolved requirements the estimator also uses — so the
          // analysis and the estimate are derived from the same input.
          taskDescription: describeEnrichedTask(enrichedTask),
          targetModel: model,
          optimization,
          budget,
          clarifyingAnswers,
          // The prompt is written for the FINAL canonical scope, so it can
          // never ask for work the plan deferred.
          resolvedScope: {
            included: includedRequirements(finalScope).map((unit) => unit.name),
            deferred: excludedRequirements(finalScope).map((unit) => unit.name),
          },
          ...(referenceBrief ? { referenceBrief } : {}),
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

    // The model and scope were resolved before this call; reuse them so the
    // prompt and the plan cannot disagree.
    const preliminary = cost;
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
      resolvedScope: {
        included: includedRequirements(finalScope).map((unit) => unit.name),
        deferred: excludedRequirements(finalScope).map((unit) => unit.name),
      },
      ...(referenceBrief ? { referenceBrief } : {}),
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

  /** The analysis shown to the user. */
  const analysis = rawAnalysis;


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

  /**
   * The legacy `optimizedScope` view: the reduction being OFFERED.
   *
   * Derived from the optimizer's single result rather than produced by a second
   * optimization pass, so there is still only one scope computation. It always
   * reflects what could be deferred, even before the user accepts it — that is
   * what lets the UI offer the reduction.
   *
   * When the user has accepted it, this is identical to `finalScope`.
   */
  const offeredScope = optimized ? optimized.finalScope : null;
  const optimizedScope: PlanResult["optimizedScope"] =
    offeredScope && offeredScope.reductions.length > 0
      ? {
          included: includedRequirements(offeredScope).map((unit) =>
            unit.description ? `${unit.name}: ${unit.description}` : unit.name,
          ),
          deferred: excludedRequirements(offeredScope).map((unit) => unit.name),
          simplified: ["Deliver the smallest complete version before adding enhancements."],
          rationale: offeredScope.rationale.join(" "),
        }
      : null;

  /**
   * FINAL CONSISTENCY VALIDATION.
   *
   * Invariants:
   *   1. the model the prompt was written for IS the resolved target model;
   *   2. the cost was computed with that same model;
   *   3. Auto resolves to a concrete model, never "auto";
   *   4. core requirements were not removed by optimization;
   *   5. deferred requirements do not appear as required work in the prompt.
   *
   * A violation makes the plan untrue, so it is surfaced as a structured error
   * instead of being silently repaired after the prompt was written.
   */
  assertPlanConsistency({
    resolvedModelId: model.id,
    promptModelId: model.id,
    costModelId: cost.modelId,
    finalScope,
    estimateScope: finalScope,
    promptScope: finalScope,
    reestimate: (scope) => canonical.estimate(scope.includedIds, scope),
    reportedEstimate: cost.recommendedMaximum,
    prompt,
    autoSelected,
  });

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
    finalScope,
    promptModelId: model.id,
    resolvedModelReason: autoSelected
      ? (recommendation?.reasons[0] ?? "Cheapest model that meets this task's capability requirements.")
      : undefined,
    /** True when even the safest scope reduction leaves the budget short. */
    optimizationInsufficient: optimizationStillInsufficient,
    /**
     * The reference understanding used for this plan. Absent for text-only
     * requests, so the UI shows nothing rather than an empty section.
     */
    ...(referenceAnalyses.length ? { referenceAnalysis: referenceAnalyses } : {}),
    /** Why references changed the estimate, when they did. */
    ...(referenceSignal.driver ? { referenceCostDriver: referenceSignal.driver } : {}),
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