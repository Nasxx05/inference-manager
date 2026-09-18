import { MODELS, VIABILITY_THRESHOLD, capabilityScoreFor, getModel } from "@/data/models";
import { estimateCost } from "@/lib/estimator/costEstimator";
import type {
  ModelComparisonRow,
  ModelRecommendation,
  OptimizationPreference,
  TaskAnalysis,
} from "@/types";

/**
 * Pick the cheapest VIABLE model for this task, budget and preference.
 * Never the cheapest outright: capability must clear the task's threshold.
 */
export function selectModel(
  analysis: TaskAnalysis,
  budget: number,
  preference: OptimizationPreference,
): ModelRecommendation {
  const threshold = VIABILITY_THRESHOLD[analysis.complexity] ?? 62;

  const candidates = MODELS.map((model) => {
    const capability = capabilityScoreFor(model, analysis.taskType);
    const estimate = estimateCost(analysis, model, preference);
    return { model, capability, estimate };
  }).filter((c) => c.capability >= threshold);

  const pool = candidates.length > 0 ? candidates : MODELS.map((model) => ({
    model,
    capability: capabilityScoreFor(model, "general"),
    estimate: estimateCost(analysis, model, preference),
  }));

  const scored = pool.map((c) => {
    const costScore = scoreCost(c.estimate.maximum, budget);
    const qualityScore = c.capability / 100;
    const budgetLeft = (budget - c.estimate.recommendedMaximum) / Math.max(budget, 1);
    const weighted = weightPreference(costScore, qualityScore, budgetLeft, preference);
    return { ...c, weighted };
  });

  scored.sort((a, b) => b.weighted - a.weighted);
  const best = scored[0];

  return {
    modelId: best.model.id,
    displayName: best.model.displayName,
    estimated: best.estimate.maximum,
    reasons: buildReasons(best.capability, best.estimate.maximum, budget, preference),
  };
}

/**
 * Cost score peaks when a model uses the budget sensibly rather than being
 * merely cheap. Leaving the budget almost untouched signals an under-scoped
 * choice, so very low ratios score slightly below the ideal band.
 */
function scoreCost(maximum: number, budget: number): number {
  if (budget <= 0) return 0;
  const ratio = maximum / budget;
  if (ratio >= 1) return 0;
  if (ratio >= 0.75) return 1 - (ratio - 0.75) / 0.75;
  if (ratio >= 0.45) return 1;
  // Below 45% of budget: still viable, but scaled down for leaving value unused.
  return 0.55 + (ratio / 0.45) * 0.45;
}

function weightPreference(
  costScore: number,
  qualityScore: number,
  budgetLeft: number,
  preference: OptimizationPreference,
): number {
  const clampedLeft = Math.max(-1, Math.min(1, budgetLeft));
  switch (preference) {
    case "minimize-cost":
      return costScore * 0.55 + qualityScore * 0.3 + clampedLeft * 0.15;
    case "maximum-quality":
      return costScore * 0.15 + qualityScore * 0.65 + clampedLeft * 0.2;
    default:
      return costScore * 0.3 + qualityScore * 0.5 + clampedLeft * 0.2;
  }
}

function buildReasons(
  capability: number,
  maximum: number,
  budget: number,
  preference: OptimizationPreference,
): string[] {
  const reasons: string[] = [];
  reasons.push(`Suitable for this task complexity (capability score ${Math.round(capability)}/100)`);
  reasons.push(`Strong enough for the requested output`);

  const remaining = Math.round((budget - maximum) * 100) / 100;
  if (remaining > 0) {
    reasons.push(`Leaves roughly ${remaining} CREDIT for validation and revision`);
  } else {
    reasons.push(`Estimated cost is close to the budget ceiling, so keep revisions targeted`);
  }

  if (preference === "minimize-cost") {
    reasons.push(`Most economical viable option for this task`);
  } else if (preference === "maximum-quality") {
    reasons.push(`Favours higher capability while staying inside the budget`);
  }
  return reasons;
}

export function buildComparison(
  analysis: TaskAnalysis,
  preference: OptimizationPreference,
  recommendation: ModelRecommendation | null,
): ModelComparisonRow[] {
  const rows = MODELS.map((model) => {
    const estimate = estimateCost(analysis, model, preference);
    return {
      modelId: model.id,
      displayName: model.displayName,
      estimated: estimate.maximum,
      capability: model.capabilityTier,
    };
  });

  if (!recommendation) return rows.slice(0, 4);

  const recommended = rows.find((r) => r.modelId === recommendation.modelId);
  const others = rows.filter((r) => r.modelId !== recommendation.modelId);
  const cheaper = [...others].sort((a, b) => a.estimated - b.estimated)[0];
  const stronger = [...others].sort((a, b) => {
    const am = getModel(a.modelId);
    const bm = getModel(b.modelId);
    if (!am || !bm) return 0;
    return capabilityScoreFor(bm, analysis.taskType) - capabilityScoreFor(am, analysis.taskType);
  })[0];

  const picked = [recommended, cheaper, stronger].filter(Boolean) as ModelComparisonRow[];
  return dedupeRows(picked);
}

function dedupeRows(rows: ModelComparisonRow[]): ModelComparisonRow[] {
  const seen = new Set<string>();
  const out: ModelComparisonRow[] = [];
  for (const row of rows) {
    if (seen.has(row.modelId)) continue;
    seen.add(row.modelId);
    out.push(row);
  }
  return out;
}