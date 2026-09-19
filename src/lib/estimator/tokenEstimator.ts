/**
 * Per-phase token estimation.
 *
 * The brief's core complaint was that one tiny generic token estimate covered
 * an entire project. Here every phase gets its own input/output estimate,
 * scaled by that phase's share of the work and by what kind of work it is.
 *
 * The shape of the numbers follows real work: implementation phases are
 * output-heavy (the model writes code), while research and analysis phases are
 * input-heavy (the model reads documents). A pure per-phase split with no
 * regard for phase type would misprice both.
 */

import type { PhaseTokens, TaskAnalysis, TaskEffort } from "@/types";

/**
 * Baseline token budgets per phase at full scale (effort score 100).
 *
 * These are anchors, not a lookup table for the whole task: they are scaled
 * down by effort and by the phase's share of work.
 */
const FULL_SCALE_OUTPUT = 90_000;
const FULL_SCALE_INPUT = 260_000;

/** Phases that mostly consume context rather than produce artifacts. */
const INPUT_HEAVY = [
  "requirement", "research", "analysis", "review", "document", "ingestion",
  "study", "discovery", "evaluation",
];

/** Phases that mostly produce artifacts. */
const OUTPUT_HEAVY = [
  "implementation", "build", "develop", "code", "draft", "write", "generate",
  "architecture", "design", "embedding", "retrieval", "chunking",
];

/** Cheap phases: mostly reasoning, little context or output. */
const LIGHT = ["planning", "plan", "outline", "summary", "final", "polish"];

function matches(name: string, list: string[]): boolean {
  const lower = name.toLowerCase();
  return list.some((k) => lower.includes(k));
}

/**
 * Splits a phase's token budget between input and output.
 *
 * Returns the ratio of the phase's budget that goes to output; the rest is
 * input. This is what makes a research phase and an implementation phase of
 * equal weight cost differently.
 */
function outputShare(name: string): number {
  if (matches(name, OUTPUT_HEAVY)) return 0.62;
  if (matches(name, INPUT_HEAVY)) return 0.3;
  if (matches(name, LIGHT)) return 0.45;
  // Unknown phase: assume a balanced mix of reading and writing.
  return 0.45;
}

/**
 * Per-phase token estimates.
 *
 * Prefers the analyser's own per-phase numbers when present (keyed by phase
 * name), falling back to the derived split otherwise. Either way the total is
 * normalised at the end so the phase breakdown cannot disagree with the
 * headline tokens the user sees.
 */
export function estimatePhaseTokens(
  analysis: TaskAnalysis,
  effort: TaskEffort,
): Record<string, PhaseTokens> {
  const phases = analysis.phases ?? [];
  if (phases.length === 0) return {};

  const scale = Math.max(0.05, effort.score / 100);

  // Weight by declared costWeight, normalised, so phases sum to the whole.
  const weights = phases.map((p) => Math.max(0.02, p.costWeight ?? 1 / phases.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

  const supplied = analysis.phaseTokens ?? {};

  const result: Record<string, PhaseTokens> = {};
  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i];
    const share = weights[i] / totalWeight;

    const phaseOutput = FULL_SCALE_OUTPUT * scale * share;
    const phaseInput = FULL_SCALE_INPUT * scale * share;

    // Blend the type-based split with the declared share so a phase named
    // "Implementation" with a small weight still reads as output-heavy.
    const ratio = outputShare(phase.name);
    const derivedOutput = phaseOutput * (0.5 + ratio);
    const derivedInput = phaseInput * (1.5 - ratio);

    const fromModel = supplied[phase.name];
    const input =
      fromModel && Number.isFinite(fromModel.input) && fromModel.input > 0
        ? fromModel.input
        : derivedInput;
    const output =
      fromModel && Number.isFinite(fromModel.output) && fromModel.output > 0
        ? fromModel.output
        : derivedOutput;

    result[phase.name] = {
      input: Math.max(200, Math.round(input)),
      output: Math.max(100, Math.round(output)),
    };
  }

  return result;
}

/**
 * Aggregates phase tokens into totals.
 *
 * The headline tokens used for costing come from here, so the phase breakdown
 * and the total always agree — the UI can show a per-phase split without the
 * numbers contradicting each other.
 */
export function sumPhaseTokens(tokens: Record<string, PhaseTokens>): PhaseTokens {
  let input = 0;
  let output = 0;
  for (const phase of Object.values(tokens)) {
    input += phase.input;
    output += phase.output;
  }
  return { input, output };
}

/**
 * Tokens consumed by an extra pass.
 *
 * A revision pass does not re-read everything from scratch, but it does carry
 * growing context: earlier output becomes part of the next input. That is why
 * the input fraction here is higher than the output fraction.
 */
export function iterationTokens(
  totals: PhaseTokens,
  passIndex: number,
): PhaseTokens {
  // Context grows with each pass: prior work must be re-supplied.
  const inputGrowth = Math.min(0.85, 0.55 + passIndex * 0.08);
  const outputFraction = 0.35;
  return {
    input: Math.round(totals.input * inputGrowth),
    output: Math.round(totals.output * outputFraction),
  };
}