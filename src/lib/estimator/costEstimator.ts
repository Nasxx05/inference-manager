/**
 * Deterministic cost engine.
 *
 * Turns workload into CREDIT using model pricing. The LLM never produces the
 * final number: it estimates the work (effort, phases, tokens), and this module
 * does the arithmetic. That keeps estimates reproducible and auditable, and it
 * means a model cannot simply invent a price.
 *
 * The pipeline:
 *
 *   task effort → per-phase tokens → iteration passes → repair reserve
 *             → context/tool overhead → model pricing → cost range
 *
 * Deliberately absent: any complexity-to-credit table. Two "high complexity"
 * tasks can differ enormously, so the estimate comes from measured
 * characteristics, not a label.
 */

import type {
  Confidence,
  CostEstimate,
  ModelConfig,
  OptimizationPreference,
  TaskAnalysis,
  TaskEffort,
} from "@/types";
import { resolveTaskEffort } from "./taskEffort";
import { estimatePhaseTokens, iterationTokens, sumPhaseTokens } from "./tokenEstimator";
import { buildIterationModel, overheadFactor, repairReserveFactor } from "./iterationEstimator";

export interface EstimatorConfig {
  safetyFactor: number;
  rangeSpread: number;
  /** How far below the expected range the minimum viable budget sits. */
  minimumViableFactor: number;
}

const BASE_CONFIG: EstimatorConfig = {
  safetyFactor: 0.2,
  rangeSpread: 0.14,
  minimumViableFactor: 0.85,
};

/**
 * Quality preference affects real work, not just a safety margin: it changes
 * how many passes are planned and how much validation happens (see
 * iterationEstimator), and it widens or narrows the range accordingly.
 */
const PREFERENCE_TUNING: Record<OptimizationPreference, Partial<EstimatorConfig>> = {
  "minimize-cost": { safetyFactor: 0.12, rangeSpread: 0.12, minimumViableFactor: 0.88 },
  balanced: { safetyFactor: 0.2, rangeSpread: 0.14, minimumViableFactor: 0.85 },
  "maximum-quality": { safetyFactor: 0.3, rangeSpread: 0.18, minimumViableFactor: 0.82 },
};

export function getEstimatorConfig(preference: OptimizationPreference): EstimatorConfig {
  return { ...BASE_CONFIG, ...PREFERENCE_TUNING[preference] };
}

function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  // Guard against NaN propagating into the returned estimate.
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * f) / f;
}

/**
 * Confidence in the estimate.
 *
 * Low confidence is honest for underspecified or huge tasks, and it widens the
 * range rather than pretending to precision. Small, well-defined tasks earn
 * high confidence.
 */
export function estimateConfidence(
  analysis: TaskAnalysis,
  effort: TaskEffort,
  taskDescription: string,
): Confidence {
  const words = (taskDescription ?? "").trim().split(/\s+/).filter(Boolean).length;
  const answeredContext = (analysis.risks?.length ?? 0) > 0;

  let score = 2; // start at "medium"

  // A brief too short to describe real work is underspecified.
  if (words < 5) score -= 1;
  // Huge effort implies more unknowns.
  if (effort.score >= 80) score -= 1;
  // Many requirements means more that could have been left unclear.
  if (effort.requirementCount > 10) score -= 1;
  // Well-described, bounded work earns confidence.
  if (words >= 4 && words <= 120 && effort.score < 45) score += 1;
  if (answeredContext && effort.score < 60) score += 0;

  if (score >= 3) return "high";
  if (score <= 1) return "low";
  return "medium";
}

export interface EstimateInput {
  analysis: TaskAnalysis;
  model: ModelConfig;
  preference: OptimizationPreference;
  taskDescription: string;
  /**
   * Clarifying-answer signal. Answers describe confirmed components, so they
   * must move the estimate — otherwise asking them would be pointless.
   */
  answerMultiplier?: number;
  addedRequirements?: number;
  configOverride?: Partial<EstimatorConfig>;
}

/**
 * `taskDescription` must be the ORIGINAL user request, never the LLM summary.
 *
 * The estimator counts requirements and gauges scope from the user's own words.
 * A one-sentence summary discards exactly the detail that separates a small
 * task from a large one, so passing it here would silently undo the workload
 * model. It is required, not optional, so a missing task is a type error rather
 * than a quietly wrong estimate.
 */
export function estimateCost(input: EstimateInput): CostEstimate;
/** Convenience overload for callers that already hold a task string. */
export function estimateCost(
  analysis: TaskAnalysis,
  model: ModelConfig,
  preference: OptimizationPreference,
  taskDescription: string,
  configOverride?: Partial<EstimatorConfig>,
): CostEstimate;
export function estimateCost(
  analysisOrInput: TaskAnalysis | EstimateInput,
  modelArg?: ModelConfig,
  preferenceArg?: OptimizationPreference,
  taskDescriptionArg?: string | Partial<EstimatorConfig>,
  configOverride?: Partial<EstimatorConfig>,
): CostEstimate {
  const input: EstimateInput =
    "analysis" in analysisOrInput && "model" in analysisOrInput
      ? (analysisOrInput as EstimateInput)
      : {
          analysis: analysisOrInput as TaskAnalysis,
          model: modelArg as ModelConfig,
          preference: preferenceArg as OptimizationPreference,
          taskDescription: typeof taskDescriptionArg === "string" ? taskDescriptionArg : "",
          configOverride:
            configOverride ??
            (typeof taskDescriptionArg === "object" ? taskDescriptionArg : undefined),
        };

  const { analysis, model, preference, taskDescription } = input;
  const config: EstimatorConfig = { ...getEstimatorConfig(preference), ...(input.configOverride ?? {}) };

  const effort = resolveTaskEffort({
    analysis,
    taskDescription,
    answerMultiplier: input.answerMultiplier,
    addedRequirements: input.addedRequirements,
  });

  // Per-phase tokens, summed so the phase breakdown and the total agree.
  const phaseTokens = estimatePhaseTokens(analysis, effort);

  /**
   * Sanitise the token totals.
   *
   * A malformed or hostile analysis can carry NaN or Infinity here, and a single
   * NaN silently poisons every downstream figure — the range, the minimum
   * viable, the reserve — producing a result that looks plausible but is
   * meaningless. Guarding once at the boundary keeps the rest of the arithmetic
   * honest without sprinkling checks through it.
   */
  const safe = (value: number, fallback: number) =>
    Number.isFinite(value) && value > 0 ? value : fallback;

  const totals =
    Object.keys(phaseTokens).length > 0
      ? sumPhaseTokens(phaseTokens)
      : {
          input: safe(analysis.estimatedInputTokens, 4_000),
          output: safe(analysis.estimatedOutputTokens, 1_500),
        };

  const totalsInput = safe(totals.input, 4_000);
  const totalsOutput = safe(totals.output, 1_500);

  const inputCost = (totalsInput / 1_000_000) * model.inputPrice;
  const outputCost = (totalsOutput / 1_000_000) * model.outputPrice;
  const baseExecutionCost = inputCost + outputCost;

  // Iteration: each extra pass re-supplies context and rewrites part of the
  // output. Modelled explicitly rather than as a flat multiplier.
  const iteration = buildIterationModel(effort, preference);
  let iterationCost = 0;
  for (let pass = 1; pass < iteration.passes; pass += 1) {
    const t = iterationTokens({ input: totalsInput, output: totalsOutput }, pass);
    iterationCost += (t.input / 1_000_000) * model.inputPrice + (t.output / 1_000_000) * model.outputPrice;
  }

  // Repair reserve: debugging, integration problems, retrieval tuning.
  // Scales with revision load and quality preference — never zero.
  const revisionCost = baseExecutionCost * repairReserveFactor(effort, preference);

  // Context and tool overhead: re-supplying large context, tool results, docs.
  const overhead = overheadFactor(effort);
  const contextOverheadCost = baseExecutionCost * overhead * 0.6;
  const toolOverheadCost = baseExecutionCost * overhead * 0.4;
  const overheadCost = contextOverheadCost + toolOverheadCost;

  const center = baseExecutionCost + iterationCost + revisionCost + overheadCost;

  const confidence = analysis.confidence ?? estimateConfidence(analysis, effort, taskDescription);
  // Wide range when confidence is low: say less, but say it honestly.
  const spread = config.rangeSpread * (confidence === "low" ? 1.4 : confidence === "high" ? 0.85 : 1);

  const baseline = center > 0 && Number.isFinite(center) ? center : 0.1;
  const minimum = Math.max(0.05, baseline * (1 - spread));
  const maximum = baseline * (1 + spread);
  const recommendedMaximum = baseline * (1 + config.safetyFactor);

  /**
   * Minimum viable budget: the floor for the core scope to have a realistic
   * chance. Set below the expected low, not at it — this is the point below
   * which completion becomes unreliable, and it is an estimate, not a promise.
   */
  const minimumViable = Math.max(0.05, minimum * config.minimumViableFactor);


  return {
    inputCost: round(inputCost, 3),
    outputCost: round(outputCost, 3),
    baseExecutionCost: round(baseExecutionCost, 3),
    iterationCost: round(iterationCost, 3),
    overheadCost: round(overheadCost, 3),
    contextOverheadCost: round(contextOverheadCost, 3),
    toolOverheadCost: round(toolOverheadCost, 3),
    revisionCost: round(revisionCost, 3),
    minimum: round(minimum, 2),
    maximum: round(maximum, 2),
    minimumViable: round(minimumViable, 2),
    recommendedMaximum: round(recommendedMaximum, 2),
    confidence,
    safetyFactor: config.safetyFactor,
    modelId: model.id,
    effort,
  };
}


/**
 * Distributes the total across phases so the UI can show where cost goes.
 *
 * Iteration, revision and overhead are spread proportionally across phases
 * rather than added to one line, so each phase reflects its true share.
 */
export function allocatePhaseCosts(
  analysis: TaskAnalysis,
  estimate: Pick<CostEstimate, "minimum" | "maximum">,
): TaskAnalysis["phases"] {
  const phases = analysis.phases ?? [];
  if (phases.length === 0) return [];

  const totalWeight = phases.reduce((sum, p) => sum + (p.costWeight > 0 ? p.costWeight : 0), 0);
  const safeWeights = totalWeight > 0 ? totalWeight : phases.length;
  const span = Math.max(0, estimate.maximum - estimate.minimum);

  return phases.map((phase, index) => {
    const weight = phase.costWeight > 0 ? phase.costWeight : 1;
    const share = weight / safeWeights;
    const low = Math.max(0.01, Math.round(estimate.minimum * share * 100) / 100);
    const high = Math.max(low + 0.01, Math.round((estimate.minimum * share + span * share) * 100) / 100);
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
  // Never render "NaN CREDIT": a planning figure that cannot be trusted should
  // read as zero rather than as a broken number.
  if (!Number.isFinite(value)) return "0";
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 100) / 100);
}

export function formatRange(min: number, max: number): string {
  return `${formatCredit(min)} – ${formatCredit(max)}`;
}

/**
 * Human-readable reasons the estimate is what it is.
 *
 * Shown under the budget panel so a large number is explainable rather than
 * arbitrary. Derived from the actual workload signals, never invented.
 */
export function explainCost(analysis: TaskAnalysis, effort: TaskEffort): string[] {
  const drivers: string[] = [];

  if (effort.requirementCount > 1) {
    drivers.push(
      `${effort.requirementCount} distinct requirement${effort.requirementCount === 1 ? "" : "s"} detected`,
    );
  }
  if (effort.implementationSize >= 55) drivers.push("substantial implementation work");
  if (effort.contextOverhead >= 55) drivers.push("large context and document handling");
  if (effort.toolOverhead >= 40) drivers.push("tooling and external integration work");
  if (effort.revisionLoad >= 50) drivers.push("expected debugging and revision cycles");

  const phases = analysis.phases ?? [];
  if (phases.length >= 6) drivers.push(`${phases.length} execution phases`);

  const iterations = effort.estimatedIterations;
  if (iterations.max >= 5) {
    drivers.push(`${iterations.min}–${iterations.max} expected iterations`);
  }

  // Fall back to the analyser's own drivers if the workload signals are quiet,
  // so there is always something meaningful to say.
  if (drivers.length === 0) {
    return analysis.costDrivers?.length ? analysis.costDrivers.slice(0, 5) : ["a small, well-defined task"];
  }

  return drivers.slice(0, 6);
}