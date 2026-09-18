import type { OptimizedScope, TaskAnalysis } from "@/types";

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

  return {
    ...analysis,
    phases,
    estimatedInputTokens: Math.round(analysis.estimatedInputTokens * 0.7),
    estimatedOutputTokens: Math.round(analysis.estimatedOutputTokens * 0.55),
    expectedIterations: Math.max(1, analysis.expectedIterations - 1),
  };
}