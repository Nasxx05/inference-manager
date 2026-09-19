/**
 * Model-task suitability.
 *
 * Completely independent from budget feasibility. "Can this model handle it?"
 * and "can the user afford it?" are separate questions, and collapsing them
 * hides the fix — a weak model needs switching, an insufficient budget needs
 * more credit or less scope.
 *
 * No model is named anywhere in this file. Verdicts come from comparing the
 * task's requirement profile against each model's capability profile, so
 * adding or renaming models in the registry requires no change here.
 */

import type {
  ModelConfig,
  ModelSuitability,
  SuitabilityStatus,
  TaskAnalysis,
  TaskRequirementProfile,
} from "@/types";
import {
  REQUIREMENT_DIMENSIONS,
  capabilityProfile,
  deriveRequirementProfile,
} from "./capabilities";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";

/** How far below a requirement a model may sit before it is a real gap. */
const ACCEPTABLE_SHORTFALL = 12;
/** Beyond this, the model is the wrong tool rather than merely weaker. */
const SERIOUS_SHORTFALL = 25;

export interface SuitabilityInput {
  model: ModelConfig;
  analysis: TaskAnalysis;
  taskDescription: string;
  /** All candidate models, for finding a better suggestion. */
  candidates: ModelConfig[];
  /** True when the user explicitly chose this model (not auto-selected). */
  explicit: boolean;
  /** True when the user chose to keep a model we advised against. */
  overridden?: boolean;
  /** Estimated cost with the current model, for the switch delta. */
  currentEstimate?: number;
}

function profileFor(analysis: TaskAnalysis, taskDescription: string): TaskRequirementProfile {
  if (analysis.requirementProfile) return analysis.requirementProfile;
  const effort = resolveTaskEffort({ analysis, taskDescription });
  return deriveRequirementProfile({
    taskType: analysis.taskType,
    complexity: analysis.complexity,
    effortScore: effort.score,
  });
}

/**
 * Scores a model against the task.
 *
 * Returns the weighted gap and the specific dimensions where the model falls
 * short, so the UI can say *why* rather than just showing a red X.
 */
export function evaluateFit(
  model: ModelConfig,
  profile: TaskRequirementProfile,
): { weightedGap: number; gaps: string[]; strengths: string[] } {
  const caps = capabilityProfile(model);
  let weightedGap = 0;
  let weightTotal = 0;
  /** Worst shortfall on a dimension this model is judged on. */
  let worstWeighted = 0;
  const gaps: string[] = [];
  const strengths: string[] = [];

  for (const dimension of REQUIREMENT_DIMENSIONS) {
    const required = Number(profile[dimension.key] ?? 0);
    const actual = Number(caps[dimension.capability] ?? 0);
    const shortfall = required - actual;
    const weight = dimension.weight;

    weightTotal += weight;
    if (shortfall > 0) {
      weightedGap += shortfall * weight;
      worstWeighted = Math.max(worstWeighted, shortfall * weight);
      if (shortfall >= ACCEPTABLE_SHORTFALL) {
        gaps.push(dimension.label);
      }
    } else if (actual - required >= 10) {
      strengths.push(dimension.label);
    }
  }

  const averageGap = weightTotal > 0 ? weightedGap / weightTotal : 0;

  /**
   * Use the worst dimension, not the average.
   *
   * Averaging dilutes a disqualifying weakness: a model 20 points short on
   * coding but fine everywhere else averages down to "acceptable", when in
   * practice it cannot do the work. The verdict should reflect the binding
   * constraint — the weakest link is what fails.
   */
  return {
    weightedGap: Math.max(averageGap, worstWeighted),
    gaps,
    strengths,
  };
}

/**
 * Produces the three-way verdict.
 *
 * suitable      — capability meets the task
 * acceptable    — usable, but a stronger model would be better
 * not-recommended — a real capability gap; the model is unlikely to be a good fit
 */
export function evaluateSuitability(input: SuitabilityInput): ModelSuitability {
  const { model, analysis, taskDescription, candidates, overridden = false } = input;
  const profile = profileFor(analysis, taskDescription);
  const { weightedGap, gaps, strengths } = evaluateFit(model, profile);

  let status: SuitabilityStatus;
  if (weightedGap >= SERIOUS_SHORTFALL) status = "not-recommended";
  else if (weightedGap >= ACCEPTABLE_SHORTFALL) status = "acceptable";
  else status = "suitable";

  const reasons: string[] = [];
  if (status === "suitable") {
    reasons.push(
      strengths.length
        ? `Capability meets this task, with headroom in ${strengths.slice(0, 2).join(" and ")}.`
        : "Capability meets the demands of this task.",
    );
  } else if (status === "acceptable") {
    reasons.push("This model can likely handle the task, but with limited headroom.");
    if (gaps.length) reasons.push(`Tightest area: ${gaps.slice(0, 2).join(", ")}.`);
  } else {
    reasons.push("The selected model is unlikely to be a good fit for this task.");
    if (gaps.length) reasons.push(`Shortfalls: ${gaps.slice(0, 3).join(", ")}.`);
  }

  // Suggest a better model only when there is a genuine gap.
  let suggestedModelId: string | undefined;
  let suggestedModelName: string | undefined;
  let suggestedDelta: number | undefined;

  if (status !== "suitable") {
    const better = suggestBetterModel(profile, candidates, model);
    if (better) {
      suggestedModelId = better.id;
      suggestedModelName = better.displayName;
    }
  }

  const headline =
    status === "suitable"
      ? "Strong fit"
      : status === "acceptable"
        ? "May handle it, stronger model recommended"
        : "Not recommended for this task";

  return {
    status,
    headline,
    reasons,
    capabilityGaps: gaps,
    suggestedModelId,
    suggestedModelName,
    suggestedDelta,
    overridden,
  };
}

/**
 * Cheapest model that clears the capability bar.
 *
 * The objective is explicitly not "cheapest" and not "strongest": it is the
 * cheapest model that is sufficiently capable, which is what makes auto-select
 * sensible on both a small task and a large one.
 */
export function suggestBetterModel(
  profile: TaskRequirementProfile,
  candidates: ModelConfig[],
  current: ModelConfig,
): ModelConfig | undefined {
  const viable = candidates
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => ({ candidate, fit: evaluateFit(candidate, profile) }))
    // Must be a genuine improvement, not just a different model.
    .filter(({ candidate, fit }) => {
      const currentGap = evaluateFit(current, profile).weightedGap;
      return fit.weightedGap < currentGap - 4 && fit.gaps.length === 0;
    })
    .sort((a, b) => {
      // Cheapest sufficient model: compare price, then capability as tiebreak.
      const priceA = a.candidate.inputPrice + a.candidate.outputPrice;
      const priceB = b.candidate.inputPrice + b.candidate.outputPrice;
      if (priceA !== priceB) return priceA - priceB;
      return b.candidate.codingCapability - a.candidate.codingCapability;
    });

  return viable[0]?.candidate;
}

/**
 * Selects a model for auto mode: cheapest that is sufficiently capable.
 *
 * Preference nudges the bar — maximum quality tolerates a pricier model for
 * extra headroom, while minimize cost accepts a tighter fit.
 */
export function selectCapableModel(
  profile: TaskRequirementProfile,
  candidates: ModelConfig[],
  preference: string,
): ModelConfig | undefined {
  const tolerance = preference === "maximum-quality" ? -6 : preference === "minimize-cost" ? 8 : 0;

  const ranked = candidates
    .map((candidate) => ({ candidate, fit: evaluateFit(candidate, profile) }))
    .filter(({ fit }) => fit.weightedGap <= ACCEPTABLE_SHORTFALL + tolerance)
    .sort((a, b) => {
      // Prefer the smallest gap first (most capable for the task), then price.
      if (Math.abs(a.fit.weightedGap - b.fit.weightedGap) > 3) {
        return a.fit.weightedGap - b.fit.weightedGap;
      }
      const priceA = a.candidate.inputPrice + a.candidate.outputPrice;
      const priceB = b.candidate.inputPrice + b.candidate.outputPrice;
      return priceA - priceB;
    });

  // Fall back to the most capable available model if none clear the bar.
  return (
    ranked[0]?.candidate ??
    [...candidates].sort(
      (a, b) => b.codingCapability + b.reasoningCapability - (a.codingCapability + a.reasoningCapability),
    )[0]
  );
}