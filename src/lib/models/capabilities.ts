/**
 * Model capability profiles.
 *
 * Suitability compares a task's demands against a model's capabilities on the
 * same 0-100 scales. Nothing here mentions a model by id: adding, removing or
 * renaming a model in the registry changes nothing in this file, which is what
 * keeps the engine model-agnostic.
 *
 * `structuredOutputCapability` is derived rather than stored, because the
 * existing ModelConfig has no field for it. Deriving from reasoning and coding
 * keeps a single source of truth per model instead of a second hand-maintained
 * list that could drift.
 */

import type { CapabilityTier, ModelConfig, TaskRequirementProfile } from "@/types";

/** Capability of a model, on the same scales as a task's requirements. */
export interface ModelCapabilityProfile {
  modelId: string;
  capabilityTier: CapabilityTier;
  coding: number;
  reasoning: number;
  research: number;
  longContext: number;
  structuredOutput: number;
}

/** Normalises a context window onto 0-100. 200k tokens reads as full marks. */
function contextScore(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 20;
  // Log scale: doubling context has diminishing practical returns.
  const score = (Math.log10(contextWindow) - Math.log10(4000)) / (Math.log10(400000) - Math.log10(4000));
  return Math.round(Math.min(100, Math.max(10, score * 100)));
}

export function capabilityProfile(model: ModelConfig): ModelCapabilityProfile {
  return {
    modelId: model.id,
    capabilityTier: model.capabilityTier,
    coding: model.codingCapability,
    reasoning: model.reasoningCapability,
    research: model.researchCapability,
    longContext: contextScore(model.contextWindow),
    // Structured output tracks reasoning most closely, with coding as a
    // secondary signal, so no new per-model field is needed.
    structuredOutput: Math.round(model.reasoningCapability * 0.6 + model.codingCapability * 0.4),
  };
}

/**
 * Requirement dimensions compared for suitability.
 *
 * Ordered by how much a shortfall matters: a coding gap on a coding task is
 * disqualifying; a research gap on the same task is a minor annoyance.
 */
export const REQUIREMENT_DIMENSIONS = [
  { key: "codingRequirement", capability: "coding", label: "coding capability", weight: 1.2 },
  { key: "reasoningRequirement", capability: "reasoning", label: "reasoning capability", weight: 1.2 },
  { key: "contextRequirement", capability: "longContext", label: "context handling", weight: 0.9 },
  { key: "researchRequirement", capability: "research", label: "research capability", weight: 0.7 },
  {
    key: "structuredOutputRequirement",
    capability: "structuredOutput",
    label: "structured output reliability",
    weight: 0.6,
  },
] as const;

/**
 * Derives a task requirement profile when the analyser does not supply one.
 *
 * Falls back to complexity and task type, so suitability still works on older
 * or partial payloads rather than silently reporting everything as fine.
 */
export function deriveRequirementProfile(input: {
  taskType: string;
  complexity: string;
  effortScore: number;
}): TaskRequirementProfile {
  const base = { low: 25, medium: 45, high: 68, "very-high": 85 }[input.complexity] ?? 45;
  const effort = Math.min(100, Math.max(0, input.effortScore));
  // Blend declared complexity with measured effort; effort dominates slightly.
  const general = Math.round(base * 0.45 + effort * 0.55);

  const isCoding = input.taskType === "coding" || input.taskType === "web-development";
  const isResearch =
    input.taskType === "research" ||
    input.taskType === "document-analysis" ||
    input.taskType === "data-analysis";

  /**
   * Demand rises steeply with effort, not gently.
   *
   * A large build cannot be attempted by a weak model: it fails partway and
   * burns the budget on corrections. So a high-effort task demands near-frontier
   * capability, while a small task stays within reach of cheap models. Without
   * this steepness the derived floor stays low enough that a mini model reads as
   * a "strong fit" for a production RAG pipeline — exactly the mistake the
   * suitability engine exists to catch.
   *
   * The ceiling is 88, not 100. Saturating at 100 would mean no model can ever
   * clear the bar, so every model would be flagged and the verdict would carry
   * no information. High effort should demand a *lot*, not the impossible.
   */
  const demand = Math.min(88, 40 + general * 0.6);

  if (isCoding) {
    return {
      codingRequirement: Math.min(100, demand + 10),
      reasoningRequirement: Math.min(100, demand),
      /**
       * Context and research stay proportional to the task, not to raw effort.
       *
       * Previously these scaled with `demand` alone, so a large coding task
       * demanded maximum research and context handling. That flagged even
       * frontier models as merely "acceptable" and made the verdict useless.
       * A build task is coding- and reasoning-bound; context matters, but it is
       * not the binding constraint.
       */
      researchRequirement: Math.round(demand * 0.45),
      contextRequirement: Math.round(demand * 0.7),
      structuredOutputRequirement: Math.round(demand * 0.8),
    };
  }

  if (isResearch) {
    return {
      codingRequirement: Math.round(demand * 0.4),
      reasoningRequirement: Math.min(100, demand),
      researchRequirement: Math.min(100, demand + 8),
      contextRequirement: Math.min(100, demand + 8),
      structuredOutputRequirement: Math.round(demand * 0.85),
    };
  }

  // Writing, creative, planning and general work: reasoning-led, little coding.
  return {
    codingRequirement: Math.round(demand * 0.35),
    reasoningRequirement: demand,
    researchRequirement: Math.round(demand * 0.6),
    contextRequirement: Math.round(demand * 0.8),
    structuredOutputRequirement: Math.round(demand * 0.85),
  };
}
