/**
 * Budget-aware scope optimization.
 *
 * The previous implementation dropped a fixed half of the optional phases
 * (`dropCount = ceil(optional.length / 2)`), which is not optimization in any
 * meaningful sense: it ignores how much each item costs, how much it matters,
 * and whether the result actually fits the budget. It could cut work that was
 * not needed, or cut nowhere near enough.
 *
 * This version treats requirements as structured units and optimizes toward the
 * user's planning budget:
 *
 *   1. Rank reducible candidates by "cost saved per unit of value lost",
 *      with essential work excluded entirely.
 *   2. Defer the worst-value candidate.
 *   3. Re-estimate immediately — never reuse the previous figure.
 *   4. Stop when the plan fits, or when nothing safe remains to defer.
 *
 * It is deterministic: given the same inputs it returns the same scope, so it
 * is testable without mocking.
 */

import type { OptimizedScope, TaskAnalysis } from "@/types";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";
import { WEIGHT_VALUE, type RequirementWeight } from "@/lib/clarifier/enrichedTask";

/** A unit of work the optimizer may consider reducing. */
export interface ScopeUnit {
  /** Stable identifier: requirement name or phase name. */
  name: string;
  description?: string;
  /**
   * Whether this work is load-bearing. Essential units are never deferred —
   * meeting the budget by removing what the task actually is would be
   * dishonest.
   */
  essential: boolean;
  /** Estimated workload weight, used as a proxy for cost. */
  weight: RequirementWeight;
  /** Expected value to the user. Lower is a better deferral candidate. */
  value: RequirementWeight;
  /**
   * Other units this one depends on. A unit is only deferrable when nothing
   * still in scope depends on it, so deferrals cannot orphan required work.
   */
  dependsOn: string[];
}

export interface OptimizationContext {
  taskDescription: string;
  analysis: TaskAnalysis;
  budget: number;
  /**
   * Estimates the cost of a proposed scope. Injected so the optimizer can
   * re-estimate after every step without knowing how estimation works.
   */
  estimate: (includedNames: string[]) => number;
  /** Resolved requirements to optimize over, when available. */
  requirements?: { name: string; weight: RequirementWeight; essential?: boolean }[];
}

export interface OptimizationResult {
  scope: OptimizedScope | null;
  /** True when the final scope fits the budget. */
  withinBudget: boolean;
  /** Cost after optimization, or null when nothing was optimized. */
  finalEstimate: number | null;
  /** Cost before optimization. */
  originalEstimate: number;
  /** What was deferred, in the order it was deferred. */
  deferredOrder: string[];
  /** Names that could not be deferred (essential or depended upon). */
  protectedNames: string[];
  /**
   * True when the budget is still not met after every safe reduction. The UI
   * must surface this rather than implying the task is feasible.
   */
  stillInsufficient: boolean;
}

/**
 * Ranks a unit as a deferral candidate.
 *
 * Higher is a better candidate. Cost dominates, value discounts it, and
 * essential work is never a candidate at all. This is what makes "defer
 * analytics" happen before "defer the database".
 */
function deferralScore(unit: ScopeUnit): number {
  if (unit.essential) return -1;
  const cost = WEIGHT_VALUE[unit.weight];
  const value = WEIGHT_VALUE[unit.value];
  // Value is deliberately raised to a power > 1 so that high-value work is
  // protected strongly even when it is cheap to keep.
  return cost / Math.max(1, value ** 1.2);
}

/** True when a still-included unit depends on `name`. */
function isDependedOn(name: string, remaining: ScopeUnit[]): boolean {
  const lower = name.toLowerCase();
  return remaining.some(
    (unit) =>
      unit.name.toLowerCase() !== lower &&
      unit.dependsOn.some((dep) => dep.toLowerCase() === lower),
  );
}

/**
 * Builds units from the analysis.
 *
 * Requirements are the primary unit when available, because they are what the
 * user actually asked for and what can be deferred ("payments", "analytics").
 * Phases ("Requirements", "Execution") are a generic shell that is mostly
 * essential, so optimizing over them alone leaves almost nothing reducible.
 *
 * Phases are still included as essential units so that deferring a requirement
 * cannot leave an empty plan, and as a fallback when no requirements exist.
 */
export function buildScopeUnits(
  analysis: TaskAnalysis,
  requirements?: { name: string; weight: RequirementWeight; essential?: boolean }[],
): ScopeUnit[] {
  const units: ScopeUnit[] = [];
  const seen = new Set<string>();

  for (const requirement of requirements ?? []) {
    const key = requirement.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({
      name: requirement.name,
      essential: requirement.essential ?? false,
      // The enriched task's own weight: payments count for more than a contact
      // section, so deferring payments saves more.
      weight: requirement.weight,
      // Value tracks weight by default — expensive components are usually the
      // point of the request — but analysis can override it.
      value: requirement.weight,
      dependsOn: [],
    });
  }

  for (const phase of analysis.phases ?? []) {
    const key = phase.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const essential = phase.priority === "essential";
    // Phase weight approximates cost from its declared share of total cost.
    const weight: RequirementWeight =
      phase.costWeight >= 0.3 ? "high" : phase.costWeight >= 0.15 ? "medium" : "low";
    units.push({
      name: phase.name,
      description: phase.description,
      essential,
      weight,
      // Essential work is inherently high value; optional work, low.
      value: essential ? "high" : phase.priority === "recommended" ? "medium" : "low",
      dependsOn: [],
    });
  }

  return units;
}

/**
 * Optimizes the scope toward the user's budget.
 *
 * Reduces progressively — one unit at a time, re-estimating each time — rather
 * than making a single large cut. That avoids overshooting: cutting three
 * features when one would have sufficed is a worse plan, not a safer one.
 */
export function optimizeScopeForBudget(context: OptimizationContext): OptimizationResult {
  const { budget, estimate } = context;

  const units = buildScopeUnits(context.analysis, context.requirements);
  const allNames = units.map((unit) => unit.name);
  const originalEstimate = estimate(allNames);

  const deferred: string[] = [];
  const deferredOrder: string[] = [];
  const active = [...units];

  let current = originalEstimate;
  let guard = 0;

  while (current > budget && guard < 24) {
    guard += 1;

    const candidates = active
      .filter((unit) => !isDependedOn(unit.name, active))
      .map((unit) => ({ unit, score: deferralScore(unit) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    // Nothing safe left to defer: stop rather than removing essential work.
    if (candidates.length === 0) break;

    const next = candidates[0].unit;
    active.splice(
      active.findIndex((unit) => unit.name === next.name),
      1,
    );

    // Guard against a deferral that does not actually help: if removing work
    // does not reduce the estimate, undo it and stop instead of looping.
    const after = estimate(active.map((unit) => unit.name));
    if (after >= current) {
      active.push(next);
      break;
    }

    current = after;
    deferred.push(next.name);
    deferredOrder.push(next.name);
  }

  const protectedNames = active
    .filter((unit) => unit.essential)
    .map((unit) => unit.name);

  if (deferred.length === 0) {
    return {
      scope: null,
      withinBudget: originalEstimate <= budget,
      finalEstimate: null,
      originalEstimate,
      deferredOrder: [],
      protectedNames,
      stillInsufficient: originalEstimate > budget,
    };
  }

  const simplified = [
    "Deliver the smallest complete version of the in-scope work before adding enhancements.",
  ];

  return {
    scope: {
      included: active.map((unit) =>
        unit.description ? `${unit.name}: ${unit.description}` : unit.name,
      ),
      deferred,
      simplified,
      rationale: buildRationale(
        originalEstimate,
        current,
        budget,
        deferred,
        current > budget,
      ),
    },
    withinBudget: current <= budget,
    finalEstimate: current,
    originalEstimate,
    deferredOrder,
    protectedNames,
    stillInsufficient: current > budget,
  };
}

function buildRationale(
  original: number,
  optimized: number,
  budget: number,
  deferred: string[],
  stillOver: boolean,
): string {
  const saved = Math.round((original - optimized) * 100) / 100;
  const base =
    `The full scope is estimated at approximately ${original} CREDIT against a ` +
    `planning budget of ${budget} CREDIT. Deferring ${deferred.length} ` +
    `lower-value item${deferred.length === 1 ? "" : "s"} brings the estimate to ` +
    `approximately ${optimized} CREDIT (about ${saved} CREDIT saved). ` +
    `Essential work was preserved.`;

  if (stillOver) {
    return (
      `${base} Even after every safe reduction, the remaining scope is still ` +
      `estimated above the planning budget — the budget is insufficient for ` +
      `this task as described, so consider raising it or reducing the goal itself.`
    );
  }

  return base;
}

/**
 * Applies a scope reduction to an analysis.
 *
 * `taskDescription` is the ORIGINAL request, passed in by the caller. It must
 * not be reconstructed from `analysis.summary`: the summary is a one-sentence
 * compression, and the effort model needs the user's full wording to judge what
 * remains after deferrals.
 */
export function applyScopeReduction(
  analysis: TaskAnalysis,
  scope: OptimizedScope,
  taskDescription: string,
): TaskAnalysis {
  const deferredNames = new Set(scope.deferred.map((d) => d.split(/[:–-]/)[0].trim().toLowerCase()));
  const keptPhases = (analysis.phases ?? []).filter(
    (p) => !deferredNames.has(p.name.trim().toLowerCase()),
  );
  const phases = keptPhases.length > 0 ? keptPhases : (analysis.phases ?? []).slice(0, 1);

  /**
   * Reducing scope must reduce the *effort model*, not only the legacy token
   * fields. The cost engine derives tokens from effort and phases, so scaling
   * tokens alone would leave the estimate unchanged — a reduced scope that
   * still costs the same is worse than useless.
   */
  const reduced: TaskAnalysis = {
    ...analysis,
    phases,
    estimatedInputTokens: Math.round(analysis.estimatedInputTokens * 0.7),
    estimatedOutputTokens: Math.round(analysis.estimatedOutputTokens * 0.55),
    expectedIterations: Math.max(1, analysis.expectedIterations - 1),
  };

  /**
   * Resolve the effort model rather than requiring one to be present: scope
   * reduction runs on analyses from every path, including fixtures and
   * fallbacks that carry no effort block. Deriving it means the reduction
   * always has something to shrink.
   */
  const baseEffort =
    analysis.effort ?? resolveTaskEffort({ analysis, taskDescription });

  const shrink = (value: number, factor: number) => Math.max(0, Math.round(value * factor));

  return {
    ...reduced,
    effort: {
      ...baseEffort,
      // Deferring work cuts requirements and implementation most; revision
      // load falls less steeply because the remaining work still needs testing.
      requirementCount: Math.max(1, shrink(baseEffort.requirementCount, 0.7)),
      criticalRequirementCount: Math.max(1, shrink(baseEffort.criticalRequirementCount, 0.7)),
      optionalRequirementCount: Math.max(0, shrink(baseEffort.optionalRequirementCount, 0.5)),
      implementationSize: shrink(baseEffort.implementationSize, 0.7),
      contextOverhead: shrink(baseEffort.contextOverhead, 0.85),
      toolOverhead: shrink(baseEffort.toolOverhead, 0.8),
      revisionLoad: shrink(baseEffort.revisionLoad, 0.8),
      score: shrink(baseEffort.score, 0.78),
      estimatedIterations: {
        min: Math.max(1, shrink(baseEffort.estimatedIterations.min, 0.75)),
        max: Math.max(2, shrink(baseEffort.estimatedIterations.max, 0.8)),
      },
      level: baseEffort.level,
    },
  };
}

/**
 * Backwards-compatible wrapper used by the planner.
 *
 * Kept so callers that only want the scope object (rather than the full
 * optimization result) keep working unchanged.
 */
export function optimizeScope(
  analysis: TaskAnalysis,
  targetBudget: number,
  requirements?: { name: string; weight: RequirementWeight; essential?: boolean }[],
): OptimizedScope {
  const result = optimizeScopeForBudget({
    taskDescription: analysis.summary ?? "",
    analysis,
    budget: targetBudget,
    // Weight-based proxy when no estimator is supplied: defers enough
    // lower-value work to plausibly fit, without claiming a real estimate.
    requirements,
    estimate: (included) => {
      const units = buildScopeUnits(analysis, requirements).filter((unit) =>
        included.includes(unit.name),
      );
      return units.reduce((sum, unit) => sum + WEIGHT_VALUE[unit.weight], 0);
    },
  });
  return result.scope ?? emptyScope(analysis, targetBudget);
}

function emptyScope(analysis: TaskAnalysis, budget: number): OptimizedScope {
  return {
    included: (analysis.phases ?? [])
      .filter((phase) => phase.priority === "essential")
      .map((phase) => phase.name),
    deferred: (analysis.phases ?? [])
      .filter((phase) => phase.priority !== "essential")
      .map((phase) => phase.name),
    simplified: ["Deliver the smallest complete version before adding enhancements."],
    rationale:
      `The original scope is estimated above the available budget of ${budget} CREDIT. ` +
      `The version below keeps the essential outcome and defers the rest.`,
  };
}