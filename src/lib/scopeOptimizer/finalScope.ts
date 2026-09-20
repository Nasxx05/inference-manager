/**
 * The canonical final scope.
 *
 * Previously the planner held several overlapping representations — the
 * enriched task's requirements, a pre-resolved scope, the optimizer's scope, and
 * whatever the prompt writer happened to receive. They could drift, producing a
 * plan whose estimate, scope explanation and prompt disagreed.
 *
 * This module produces ONE `FinalScope` and derives everything from it:
 *
 *   buildFinalScope()  — requirements with stable ids and core/optional marking
 *   optimizeFinalScope() — bounded, deterministic, budget-aware reduction that
 *                          re-estimates each step with the CALLER'S estimator
 *
 * The estimator is injected, never reimplemented. The optimizer and the planner
 * therefore share one cost function by construction, so
 * `optimizerEstimate(scope) === finalEstimate(scope)` always holds.
 */

import type {
  FinalScope,
  ScopeReduction,
  ScopeRequirement,
  TaskAnalysis,
} from "@/types";

/** Deterministic weight ranking for cost/value comparison. */
const WEIGHT_ORDER: Record<ScopeRequirement["weight"], number> = {
  low: 1,
  medium: 3,
  high: 6,
  "very-high": 10,
};

/**
 * Turns a name into a stable id.
 *
 * Stable and derived purely from the name, so the same requirement always gets
 * the same id across optimization and re-estimation passes. That is what makes
 * included/excluded sets comparable.
 */
function toId(prefix: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}:${slug || "unnamed"}`;
}

/**
 * Requirement names that are load-bearing for almost any task.
 *
 * Used only when the analysis does not state importance. This is a
 * normalisation layer, not a judgement about the user's task: the point is to
 * avoid the previous behaviour, where every requirement was marked optional and
 * so anything could be dropped to fit a budget.
 *
 * Deliberately narrow. Marking "authentication" or "payments" core would make
 * them undeferrable for every task, which is wrong: they are exactly the
 * features a user defers when the budget is tight. Only work that is
 * inseparable from the task's purpose belongs here.
 */
const CORE_KEYWORDS = [
  "core", "main", "primary", "essential", "fundamental", "implementation", "execution",
];

export function isCoreRequirement(name: string): boolean {
  const lower = name.toLowerCase();
  return CORE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/**
 * Builds the initial FinalScope from the analysis and resolved requirements.
 *
 * When the analyser marks a phase essential, that is respected. Otherwise the
 * deterministic normalisation above decides — the system never defaults
 * everything to optional.
 */
export function buildFinalScope(input: {
  analysis: TaskAnalysis;
  requirements?: { name: string; weight: ScopeRequirement["weight"]; description?: string }[];
}): FinalScope {
  const { analysis, requirements = [] } = input;

  const units: ScopeRequirement[] = [];
  const seen = new Set<string>();

  for (const requirement of requirements) {
    const id = toId("req", requirement.name);
    if (seen.has(id)) continue;
    seen.add(id);
    units.push({
      id,
      name: requirement.name,
      description: requirement.description,
      weight: requirement.weight,
      core: isCoreRequirement(requirement.name),
      dependsOn: [],
      source: "task",
    });
  }

  // Phases provide structure when no explicit requirements exist. Essential
  // phases are core by definition; the rest are optional.
  for (const phase of analysis.phases ?? []) {
    const id = toId("phase", phase.name);
    if (seen.has(id)) continue;
    seen.add(id);
    const essential = phase.priority === "essential";
    units.push({
      id,
      name: phase.name,
      description: phase.description,
      weight: phase.costWeight >= 0.3 ? "high" : phase.costWeight >= 0.15 ? "medium" : "low",
      core: essential,
      dependsOn: [],
      source: "phase",
    });
  }

  return {
    requirements: units,
    includedIds: units.map((unit) => unit.id),
    excludedIds: [],
    reductions: [],
    optimized: false,
    stillInsufficient: false,
    rationale: [],
  };
}

export interface OptimizeScopeInput {
  scope: FinalScope;
  budget: number;
  /**
   * The CANONICAL estimator. Receives the ids currently in scope and returns a
   * comparable cost figure. Supplied by the planner so optimisation and final
   * estimation cannot diverge.
   */
  estimate: (includedIds: string[], scope: FinalScope) => number;
  /** Hard bound on passes, to prevent runaway computation. */
  maxPasses?: number;
}

export interface OptimizeScopeResult {
  finalScope: FinalScope;
  /** Cost of the final scope, from the canonical estimator. */
  estimatedCost: number;
  withinBudget: boolean;
  /** True when nothing further can be safely reduced. */
  cannotReduceFurther: boolean;
  /** Cost before optimization, for the "saved X" explanation. */
  initialCost: number;
}

/** True when a still-included requirement depends on `id`. */
function isDependedOn(id: string, scope: FinalScope, included: Set<string>): boolean {
  return scope.requirements.some(
    (unit) => included.has(unit.id) && unit.id !== id && unit.dependsOn.includes(id),
  );
}

/**
 * Ranks a requirement as a reduction candidate.
 *
 * Higher is a better candidate: high cost, low value, not core. Cost dominates
 * so the optimizer saves the most per item removed, which is what makes it
 * converge rather than shaving around the edges.
 */
function reductionScore(unit: ScopeRequirement): number {
  if (unit.core) return Number.NEGATIVE_INFINITY;
  const cost = WEIGHT_ORDER[unit.weight];
  const value = WEIGHT_ORDER[unit.weight];
  // Value is exponentiated so cheap-but-important work is strongly protected.
  return cost / Math.max(1, value ** 1.2);
}

/**
 * Optimizes the scope toward the budget.
 *
 * Deterministic and bounded: at most `maxPasses` iterations, each operating on
 * the CURRENT scope (never the original), each re-estimated with the canonical
 * estimator. A reduction that does not lower the cost is undone and the loop
 * stops, so the function can never return a scope it did not verify.
 */
export function optimizeFinalScope(input: OptimizeScopeInput): OptimizeScopeResult {
  const { scope, budget, estimate, maxPasses = 12 } = input;

  const included = new Set(scope.includedIds);
  const reductions: ScopeReduction[] = [...scope.reductions];
  const rationale: string[] = [...scope.rationale];

  const currentScope = (): FinalScope => ({
    ...scope,
    includedIds: scope.requirements
      .map((unit) => unit.id)
      .filter((id) => included.has(id)),
    excludedIds: scope.requirements
      .map((unit) => unit.id)
      .filter((id) => !included.has(id)),
    reductions,
    optimized: reductions.length > 0,
    stillInsufficient: false,
    rationale,
  });

  let cost = estimate([...included], currentScope());
  const initialCost = cost;

  if (cost <= budget) {
    return {
      finalScope: { ...currentScope(), stillInsufficient: false },
      estimatedCost: cost,
      withinBudget: true,
      cannotReduceFurther: false,
      initialCost,
    };
  }

  let cannotReduceFurther = false;

  for (let pass = 0; pass < maxPasses && cost > budget; pass += 1) {
    const candidates = scope.requirements
      .filter((unit) => included.has(unit.id))
      .filter((unit) => !isDependedOn(unit.id, scope, included))
      .map((unit) => ({ unit, score: reductionScore(unit) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      cannotReduceFurther = true;
      break;
    }

    const next = candidates[0].unit;
    included.delete(next.id);
    const after = estimate([...included], currentScope());

    if (after >= cost) {
      // Deferring this did not help — undo it rather than keeping a change that
      // only loses work.
      included.add(next.id);
      cannotReduceFurther = true;
      break;
    }

    cost = after;
    reductions.push({
      requirementId: next.id,
      name: next.name,
      action: "deferred",
      reason: `Deferred to bring the estimate within the planning budget (highest cost-to-value item remaining).`,
    });
  }

  if (reductions.length > 0) {
    const saved = Math.round((initialCost - cost) * 100) / 100;
    rationale.push(
      `Reduced ${reductions.length} optional item${reductions.length === 1 ? "" : "s"}, ` +
        `bringing the estimate from approximately ${initialCost} to ${cost} CREDIT ` +
        `(about ${saved} saved). Core work was preserved.`,
    );
    if (cost > budget) {
      rationale.push(
        "Even after every safe reduction, the remaining scope is still estimated " +
          "above the planning budget.",
      );
    }
  }

  return {
    finalScope: { ...currentScope(), stillInsufficient: cost > budget },
    estimatedCost: cost,
    withinBudget: cost <= budget,
    cannotReduceFurther,
    initialCost,
  };
}

/** Requirements retained in a scope. */
export function includedRequirements(scope: FinalScope): ScopeRequirement[] {
  const included = new Set(scope.includedIds);
  return scope.requirements.filter((unit) => included.has(unit.id));
}

/** Requirements removed or reduced away. */
export function excludedRequirements(scope: FinalScope): ScopeRequirement[] {
  const included = new Set(scope.includedIds);
  return scope.requirements.filter((unit) => !included.has(unit.id));
}

/** Ids that must remain: core work is never a reduction candidate. */
export function protectedIds(scope: FinalScope): string[] {
  return scope.requirements.filter((unit) => unit.core).map((unit) => unit.id);
}