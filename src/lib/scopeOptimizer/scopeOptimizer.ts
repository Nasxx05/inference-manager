import type { OptimizedScope, TaskAnalysis } from "@/types";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";

export function optimizeScope(analysis: TaskAnalysis, targetBudget: number): OptimizedScope {
  const phases = [...(analysis.phases ?? [])];
  const adjustments = dedupe(analysis.scopeAdjustments ?? []);

  const included: string[] = [];
  const deferred: string[] = [];
  const simplified: string[] = [];

  const essential = phases.filter((p) => p.priority === "essential");
  const optional = phases.filter((p) => p.priority !== "essential");

  for (const phase of essential) {
    included.push(`${phase.name}: ${phase.description || "core work"}`);
  }

  const optionalByCost = [...optional].sort((a, b) => b.costWeight - a.costWeight);
  const dropCount = Math.ceil(optionalByCost.length / 2);
  const dropped = new Set(optionalByCost.slice(0, dropCount).map((p) => p.name.toLowerCase()));

  for (const phase of optional) {
    if (dropped.has(phase.name.toLowerCase())) {
      deferred.push(`${phase.name} - defer to a follow-up pass if budget remains`);
    } else {
      included.push(`${phase.name}: ${phase.description || "supporting work"}`);
    }
  }

  for (const adjustment of adjustments) {
    simplified.push(adjustment);
  }
  if (simplified.length === 0) {
    simplified.push(
      "Produce the smallest complete version that satisfies the core requirements before adding enhancements.",
    );
  }

  deferred.push(...defaultDeferrals(analysis));

  return {
    included: dedupe(included),
    deferred: dedupe(deferred),
    simplified: dedupe(simplified),
    rationale:
      `The original scope is estimated above the available budget of ${targetBudget} CREDIT. ` +
      `The version below keeps the essential outcome and defers the rest.`,
  };
}

function defaultDeferrals(analysis: TaskAnalysis): string[] {
  const out: string[] = [];
  const text = JSON.stringify(analysis).toLowerCase();
  if (text.includes("auth")) out.push("Authentication and user accounts");
  if (text.includes("payment") || text.includes("checkout")) out.push("Real payment processing");
  if (text.includes("admin")) out.push("Admin dashboard");
  if (text.includes("analytic")) out.push("Analytics and telemetry");
  if (text.includes("test")) out.push("Extensive automated test suites");
  return out;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

export function applyScopeReduction(analysis: TaskAnalysis, scope: OptimizedScope): TaskAnalysis {
  const deferredNames = new Set(scope.deferred.map((d) => d.split("-")[0].trim().toLowerCase()));
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
   * Resolve the effort model rather than requiring one to be present.
   *
   * Scope reduction runs on analyses from every path, including fixtures and
   * fallbacks that carry no effort block. Deriving it means the reduction
   * always has something to shrink; returning early would silently produce a
   * "reduced" scope costing exactly the same as the original.
   */
  const baseEffort =
    analysis.effort ?? resolveTaskEffort({ analysis, taskDescription: analysis.summary ?? "" });

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
