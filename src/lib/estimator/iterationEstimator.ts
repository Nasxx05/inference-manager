/**
 * Iteration and repair modelling.
 *
 * The old estimator priced essentially one generation pass plus a flat
 * multiplier. Real work is a loop: plan, generate, test, debug, revise,
 * re-test. This module turns that loop into explicit passes so the cost of
 * testing and repair is visible rather than assumed away.
 *
 * A key rule: testing and revision are never free. Even "minimize cost" keeps
 * one correction pass, because a single-pass estimate is not a realistic plan
 * for anything non-trivial.
 */

import type { OptimizationPreference, TaskEffort } from "@/types";

export interface IterationModel {
  /** Total passes, including the initial generation. */
  passes: number;
  /** Passes spent revisiting (debugging, repair, correction). */
  revisionPasses: number;
  /** Passes spent validating (testing, review). */
  validationPasses: number;
  /** Multiplier applied to revision cost by the quality preference. */
  revisionIntensity: number;
  /** Human-readable explanation for the UI. */
  explanation: string;
}

/**
 * How hard each preference pushes on iteration.
 *
 * "Minimize cost" still keeps one correction pass — dropping to a single pass
 * would understate the work and produce a number that fails in practice.
 */
const PREFERENCE_TUNING: Record<
  OptimizationPreference,
  { revisionIntensity: number; validationBias: number }
> = {
  "minimize-cost": { revisionIntensity: 0.55, validationBias: -0.3 },
  balanced: { revisionIntensity: 1, validationBias: 0 },
  "maximum-quality": { revisionIntensity: 1.45, validationBias: 0.6 },
};

/**
 * Builds the iteration model.
 *
 * Passes are driven by the effort model's iteration range and revision load,
 * not by a fixed table: a portfolio site stays at a couple of passes while a
 * full SaaS platform lands in the high single digits.
 */
export function buildIterationModel(
  effort: TaskEffort,
  preference: OptimizationPreference,
): IterationModel {
  const tuning = PREFERENCE_TUNING[preference] ?? PREFERENCE_TUNING.balanced;

  const { min, max } = effort.estimatedIterations;
  const revisionLoad = effort.revisionLoad / 100;

  // Use the upper half of the range for planning: an estimate that assumes the
  // best case is the one that disappoints.
  const basePasses = Math.round(min + (max - min) * 0.65);
  const passes = Math.max(1, Math.min(20, basePasses));

  // Revision and validation split the passes beyond the first. Heavy revision
  // load shifts the balance toward repair; high quality shifts it toward
  // validation.
  const extra = Math.max(0, passes - 1);
  const revisionShare = Math.min(0.75, 0.45 + revisionLoad * 0.3);

  let revisionPasses = Math.max(preference === "minimize-cost" ? 1 : 0, Math.round(extra * revisionShare));
  let validationPasses = Math.max(0, extra - revisionPasses);

  // Quality preference biases the mix rather than just the total.
  if (tuning.validationBias > 0 && revisionPasses > 0) {
    const move = Math.min(revisionPasses, Math.round(tuning.validationBias));
    revisionPasses -= move;
    validationPasses += move;
  } else if (tuning.validationBias < 0 && validationPasses > 0) {
    const move = Math.min(validationPasses, Math.round(Math.abs(tuning.validationBias)));
    validationPasses -= move;
    revisionPasses += move;
  }

  const explanation =
    passes <= 1
      ? "A single focused pass, with minimal correction."
      : `${passes} passes: initial generation, ${validationPasses} validation pass${validationPasses === 1 ? "" : "es"}, and ${revisionPasses} correction pass${revisionPasses === 1 ? "" : "es"}.`;

  return {
    passes,
    revisionPasses,
    validationPasses,
    revisionIntensity: tuning.revisionIntensity,
    explanation,
  };
}

/**
 * The repair reserve, as a fraction of base execution cost.
 *
 * Scaling by revision load is what makes a RAG system's integration problems
 * and retrieval tuning show up in the estimate instead of being assumed away.
 */
export function repairReserveFactor(effort: TaskEffort, preference: OptimizationPreference): number {
  const tuning = PREFERENCE_TUNING[preference] ?? PREFERENCE_TUNING.balanced;
  const load = effort.revisionLoad / 100;
  // Never zero: even simple tasks can need one correction.
  const base = 0.12 + load * 0.5;
  return base * tuning.revisionIntensity;
}

/**
 * Context/tool overhead factor.
 *
 * Separate from repair: this covers re-supplying large context and driving
 * tools, which costs tokens even when nothing goes wrong.
 */
export function overheadFactor(effort: TaskEffort): number {
  const context = effort.contextOverhead / 100;
  const tools = effort.toolOverhead / 100;
  return 0.06 + context * 0.28 + tools * 0.16;
}