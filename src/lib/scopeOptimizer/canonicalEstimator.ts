/**
 * The ONE canonical estimator, shared by the scope optimizer and the planner.
 *
 * The optimizer previously used a proxy (a weight sum, or a re-estimate built
 * from a different analysis object) while the plan's final number came from
 * another path. Those could disagree, so a scope could be reported as "fits the
 * budget" by the optimizer and still be shown as infeasible by the plan.
 *
 * This module exposes a single factory, `createCanonicalEstimator()`, which
 * returns:
 *
 *   - `estimate(includedIds, scope)` — what the optimizer injects. Bounded to
 *     the ids currently in scope, and derived from an analysis that has been
 *     reduced to match those ids.
 *   - `estimateScope(scope)` — the final number, using the *same* code path.
 *
 * Because both go through `reduceAnalysis` + `estimateCost`,
 * `estimate(finalScope) === estimateScope(finalScope)` holds by construction.
 *
 * Scope actually moves the number: dropping requirements shrinks the effort
 * model (requirement counts, implementation size, overheads, iteration range)
 * and the retained share scales the clarifying-answer workload, so the estimate
 * falls monotonically as work is deferred.
 */

import { estimateCost } from "@/lib/estimator/costEstimator";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";
import type { FinalScope, ModelConfig, OptimizationPreference, TaskAnalysis } from "@/types";

export interface CanonicalEstimatorInput {
  /** The raw, unreduced analysis from the LLM. */
  analysis: TaskAnalysis;
  /** The resolved target model — the same one the prompt was written for. */
  model: ModelConfig;
  optimization: OptimizationPreference;
  /** The ORIGINAL task wording, never `analysis.summary`. */
  taskDescription: string;
  /** Workload multiplier contributed by clarifying answers. */
  answerMultiplier: number;
  /** Extra requirement count contributed by clarifying answers. */
  addedRequirements: number;
  /** Cached effort model for the unreduced analysis. */
  baseEffort: ReturnType<typeof resolveTaskEffort>;
  /** Requirement count in the FULL scope, used to compute the retained share. */
  fullRequirementCount: number;
}

export interface CanonicalEstimator {
  /** Cost of a scope, as a comparable single number. */
  estimate: (includedIds: string[], scope: FinalScope) => number;
  /** Full `estimateCost` output for a scope, for the plan's final numbers. */
  estimateFull: (
    scope: FinalScope,
  ) => ReturnType<typeof estimateCost>;
}

/**
 * Shrinks the analysis to match a scope.
 *
 * Deferring work must change the *effort model*, not just the legacy token
 * fields: the cost engine derives tokens from effort and phases, so scaling
 * tokens alone would leave the estimate unchanged — a reduced scope that still
 * costs the same would be worse than useless.
 */
function reduceAnalysis(
  analysis: TaskAnalysis,
  taskDescription: string,
  scope: FinalScope,
  share: number,
  baseEffort: ReturnType<typeof resolveTaskEffort>,
): TaskAnalysis {
  const included = new Set(scope.includedIds);

  // Drop phases whose requirement was deferred. Phases are workflow
  // scaffolding, so at least one must survive or the plan is empty.
  const keptPhases = (analysis.phases ?? []).filter((phase) =>
    scope.requirements
      .filter((unit) => included.has(unit.id) && unit.source === "phase")
      .some((unit) => unit.name === phase.name),
  );
  const phases =
    keptPhases.length > 0 ? keptPhases : (analysis.phases ?? []).slice(0, 1);

  const shrink = (value: number, factor: number) =>
    Math.max(0, Math.round(value * factor));

  return {
    ...analysis,
    phases,
    estimatedInputTokens: Math.round(analysis.estimatedInputTokens * (0.6 + 0.4 * share)),
    estimatedOutputTokens: Math.round(analysis.estimatedOutputTokens * (0.45 + 0.55 * share)),
    expectedIterations: Math.max(1, Math.round(analysis.expectedIterations * (0.6 + 0.4 * share))),
    effort: {
      ...baseEffort,
      // Deferring work cuts requirements and implementation most; revision load
      // falls less steeply because the remaining work still needs testing.
      requirementCount: Math.max(1, shrink(baseEffort.requirementCount, 0.55 + 0.45 * share)),
      criticalRequirementCount: Math.max(
        1,
        shrink(baseEffort.criticalRequirementCount, 0.7 + 0.3 * share),
      ),
      optionalRequirementCount: Math.max(
        0,
        shrink(baseEffort.optionalRequirementCount, 0.3 + 0.7 * share),
      ),
      implementationSize: shrink(baseEffort.implementationSize, 0.55 + 0.45 * share),
      contextOverhead: shrink(baseEffort.contextOverhead, 0.8 + 0.2 * share),
      toolOverhead: shrink(baseEffort.toolOverhead, 0.75 + 0.25 * share),
      revisionLoad: shrink(baseEffort.revisionLoad, 0.7 + 0.3 * share),
      score: shrink(baseEffort.score, 0.6 + 0.4 * share),
      estimatedIterations: {
        min: Math.max(1, shrink(baseEffort.estimatedIterations.min, 0.7 + 0.3 * share)),
        max: Math.max(2, shrink(baseEffort.estimatedIterations.max, 0.75 + 0.25 * share)),
      },
      level: baseEffort.level,
    },
  };
}

/**
 * Builds the canonical estimator.
 *
 * `share` — the fraction of the full requirement set still in scope — is what
 * makes the number respond to scope. Every field scales with it, so the
 * optimizer can always tell a helpful deferral from a useless one.
 */
export function createCanonicalEstimator(input: CanonicalEstimatorInput): CanonicalEstimator {
  const {
    analysis,
    model,
    optimization,
    taskDescription,
    answerMultiplier,
    addedRequirements,
    baseEffort,
    fullRequirementCount,
  } = input;

  const analysisForScope = (scope: FinalScope): TaskAnalysis => {
    const share =
      fullRequirementCount > 0 ? scope.includedIds.length / fullRequirementCount : 1;
    return reduceAnalysis(analysis, taskDescription, scope, share, baseEffort);
  };

  const inputsForScope = (scope: FinalScope) => {
    const share =
      fullRequirementCount > 0 ? scope.includedIds.length / fullRequirementCount : 1;
    return {
      analysis: analysisForScope(scope),
      model,
      preference: optimization,
      taskDescription,
      // Answers add real components, so their workload scales with what is kept.
      answerMultiplier: 1 + (answerMultiplier - 1) * share,
      addedRequirements: Math.round(addedRequirements * share),
    };
  };

  return {
    estimate: (includedIds, scope) =>
      estimateCost(inputsForScope({ ...scope, includedIds })).recommendedMaximum,
    estimateFull: (scope) => estimateCost(inputsForScope(scope)),
  };
}