import type { CostEstimate, ModelConfig, OptimizationPreference, TaskAnalysis } from "@/types";

export interface EstimatorConfig {
  safetyFactor: number;
  overheadFactor: number;
  rangeSpread: number;
}

const BASE_CONFIG: EstimatorConfig = {
  safetyFactor: 0.2,
  overheadFactor: 0.15,
  rangeSpread: 0.12,
};

const PREFERENCE_TUNING: Record<OptimizationPreference, Partial<EstimatorConfig>> = {
  "minimize-cost": { safetyFactor: 0.12, overheadFactor: 0.08, rangeSpread: 0.1 },
  balanced: { safetyFactor: 0.2, overheadFactor: 0.15, rangeSpread: 0.12 },
  "maximum-quality": { safetyFactor: 0.3, overheadFactor: 0.22, rangeSpread: 0.15 },
};

export function getEstimatorConfig(preference: OptimizationPreference): EstimatorConfig {
  return { ...BASE_CONFIG, ...PREFERENCE_TUNING[preference] };
}

function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function iterationCost(model: ModelConfig, analysis: TaskAnalysis, iterations: number): number {
  if (iterations <= 1) return 0;
  const extraPasses = iterations - 1;
  const perPassInput = (analysis.estimatedInputTokens * 0.75) / 1_000_000;
  const perPassOutput = (analysis.estimatedOutputTokens * 0.35) / 1_000_000;
  const perPass = perPassInput * model.inputPrice + perPassOutput * model.outputPrice;
  return perPass * extraPasses;
}

export function estimateCost(
  analysis: TaskAnalysis,
  model: ModelConfig,
  preference: OptimizationPreference,
  configOverride?: Partial<EstimatorConfig>,
): CostEstimate {
  const config: EstimatorConfig = { ...getEstimatorConfig(preference), ...(configOverride ?? {}) };

  const inputTokens = Math.max(0, analysis.estimatedInputTokens);
  const outputTokens = Math.max(0, analysis.estimatedOutputTokens);

  const inputCost = (inputTokens / 1_000_000) * model.inputPrice;
  const outputCost = (outputTokens / 1_000_000) * model.outputPrice;
  const baseExecutionCost = inputCost + outputCost;

  const iterations = Math.max(1, analysis.expectedIterations || 1);
  const iterCost = iterationCost(model, analysis, iterations);
  const overheadCost = (baseExecutionCost + iterCost) * config.overheadFactor;

  const center = baseExecutionCost + iterCost + overheadCost;

  const minimum = Math.max(0.01, center * (1 - config.rangeSpread));
  const maximum = center * (1 + config.rangeSpread);
  const recommendedMaximum = center * (1 + config.safetyFactor);

  return {
    inputCost: round(inputCost, 3),
    outputCost: round(outputCost, 3),
    baseExecutionCost: round(baseExecutionCost, 3),
    iterationCost: round(iterCost, 3),
    overheadCost: round(overheadCost, 3),
    minimum: round(minimum, 2),
    maximum: round(maximum, 2),
    recommendedMaximum: round(recommendedMaximum, 2),
    safetyFactor: config.safetyFactor,
    modelId: model.id,
  };
}

export function allocatePhaseCosts(
  analysis: TaskAnalysis,
  estimate: Pick<CostEstimate, "minimum" | "maximum">,
): TaskAnalysis["phases"] {
  const phases = analysis.phases ?? [];
  if (phases.length === 0) return [];

  const totalWeight = phases.reduce((sum, p) => sum + (p.costWeight > 0 ? p.costWeight : 0), 0);
  const safeWeights = totalWeight > 0 ? totalWeight : phases.length;
  const span = estimate.maximum - estimate.minimum;

  return phases.map((phase, index) => {
    const weight = phase.costWeight > 0 ? phase.costWeight : 1;
    const share = weight / safeWeights;
    const low = Math.max(0.01, Math.round(estimate.minimum * share * 100) / 100);
    const high = Math.max(0.02, Math.round((estimate.minimum * share + span * share) * 100) / 100);
    return {
      name: phase.name || `Phase ${index + 1}`,
      description: phase.description ?? "",
      priority: phase.priority ?? "recommended",
      costWeight: weight,
      estimatedCost: [low, high] as [number, number],
    };
  });
}

export function formatCredit(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 100) / 100);
}

export function formatRange(min: number, max: number): string {
  return `${formatCredit(min)} – ${formatCredit(max)}`;
}