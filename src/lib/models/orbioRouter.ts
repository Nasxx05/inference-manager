import type { ModelMode } from "@/types/conversation";

export type ModelTaskClass = "light_chat" | "explanation" | "requirements_reasoning" | "architecture" | "structured_project_update" | "implementation_prompt" | "code_review" | "large_repository_review" | "change_impact" | "image_analysis" | "transcription";
export type RequiredModality = "text" | "image" | "audio" | "file";

export interface OrbioCatalogueModel {
  id: string;
  contextLength: number;
  inputModalities: RequiredModality[];
  outputModalities: string[];
  inputPricePerToken?: number;
  outputPricePerToken?: number;
}

export interface ModelRouteDecision {
  model: OrbioCatalogueModel;
  reasonCode: "locked_model" | "lowest_cost_adequate";
  expectedCostClass: "low" | "medium" | "high";
  capabilityScore: number;
  estimated: boolean;
}

const minimumCapability: Record<ModelTaskClass, number> = {
  light_chat: 45, explanation: 50, requirements_reasoning: 68, architecture: 72,
  structured_project_update: 68, implementation_prompt: 74, code_review: 76,
  large_repository_review: 82, change_impact: 74, image_analysis: 64, transcription: 55,
};

interface CuratedCapabilities { coding: number; reasoning: number; structuredOutput: number; multimodal: number; speed: number; reliability: number }
const CAPABILITY_REGISTRY: Array<{ pattern: RegExp; capabilities: CuratedCapabilities }> = [
  { pattern: /whisper|transcri|asr|stt|chirp|nova/i, capabilities: { coding: 5, reasoning: 20, structuredOutput: 30, multimodal: 95, speed: 80, reliability: 82 } },
  { pattern: /gpt-6|gpt-5(?!-nano)|claude-(?:opus|sonnet)-5|gemini-3(?:\.|-|$)|glm-5|deepseek-v3|deepseek-r1|qwen3\.8/i, capabilities: { coding: 90, reasoning: 90, structuredOutput: 88, multimodal: 78, speed: 58, reliability: 86 } },
  { pattern: /gpt-4|claude-(?:opus|sonnet)|gemini-(?:2\.5|2\.0)|glm-4|deepseek-v4|qwen|coder/i, capabilities: { coding: 82, reasoning: 80, structuredOutput: 80, multimodal: 68, speed: 66, reliability: 80 } },
  { pattern: /mini|flash|haiku|small|lite|nano/i, capabilities: { coding: 62, reasoning: 60, structuredOutput: 65, multimodal: 55, speed: 90, reliability: 70 } },
];

function curatedCapabilities(model: OrbioCatalogueModel): CuratedCapabilities {
  const known = CAPABILITY_REGISTRY.find((entry) => entry.pattern.test(model.id))?.capabilities;
  if (known) return { ...known, multimodal: model.inputModalities.some((item) => item !== "text") ? known.multimodal : Math.min(known.multimodal, 35) };
  // Unknown catalogue entries are usable for light work, but are not assumed
  // to be strong engineers merely because they are new or inexpensive.
  return { coding: 45, reasoning: 45, structuredOutput: 42, multimodal: model.inputModalities.some((item) => item !== "text") ? 50 : 25, speed: 55, reliability: 50 };
}

function capability(model: OrbioCatalogueModel, task: ModelTaskClass): number {
  const value = curatedCapabilities(model);
  const longContext = model.contextLength >= 128_000 ? 88 : model.contextLength >= 64_000 ? 68 : 45;
  const score = task === "light_chat" ? value.speed * 0.55 + value.reliability * 0.25 + value.reasoning * 0.2
    : task === "explanation" ? value.reasoning * 0.55 + value.reliability * 0.3 + value.speed * 0.15
    : task === "architecture" || task === "structured_project_update" || task === "requirements_reasoning" ? value.reasoning * 0.55 + value.structuredOutput * 0.3 + value.reliability * 0.15
    : task === "implementation_prompt" ? value.coding * 0.4 + value.reasoning * 0.35 + value.structuredOutput * 0.2 + value.reliability * 0.05
    : task === "code_review" || task === "change_impact" ? value.coding * 0.5 + value.reasoning * 0.3 + value.reliability * 0.2
    : task === "large_repository_review" ? value.coding * 0.4 + value.reasoning * 0.25 + longContext * 0.25 + value.reliability * 0.1
    : task === "image_analysis" ? value.multimodal * 0.55 + value.reasoning * 0.3 + value.structuredOutput * 0.15
    : value.multimodal * 0.8 + value.reliability * 0.2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function expectedCost(model: OrbioCatalogueModel): number {
  const input = model.inputPricePerToken ?? Number.POSITIVE_INFINITY;
  const output = model.outputPricePerToken ?? input;
  return input * 3 + output;
}

function costClass(model: OrbioCatalogueModel): "low" | "medium" | "high" {
  const perMillion = expectedCost(model) * 1_000_000;
  if (perMillion <= 2) return "low";
  if (perMillion <= 15) return "medium";
  return "high";
}

function eligible(model: OrbioCatalogueModel, input: { taskClass: ModelTaskClass; requiredModalities: RequiredModality[]; contextTokens: number }): boolean {
  // Orbio exposes asynchronous batch variants in the general catalogue. They
  // are cheaper, but cannot be used by the synchronous chat-completions path
  // that powers an interactive Promgent turn.
  return !model.id.endsWith(":batch")
    && input.requiredModalities.every((modality) => model.inputModalities.includes(modality))
    && model.contextLength >= input.contextTokens
    && capability(model, input.taskClass) >= minimumCapability[input.taskClass];
}

export class ModelRoutingError extends Error {
  constructor(readonly code: "MODEL_UNAVAILABLE" | "MODEL_INCOMPATIBLE", message: string) { super(message); this.name = "ModelRoutingError"; }
}

export function routeOrbioModel(input: {
  models: OrbioCatalogueModel[];
  mode: ModelMode;
  lockedModel?: string;
  taskClass: ModelTaskClass;
  requiredModalities?: RequiredModality[];
  contextTokens?: number;
}): ModelRouteDecision {
  const requirements = { taskClass: input.taskClass, requiredModalities: input.requiredModalities ?? ["text"], contextTokens: input.contextTokens ?? 16_000 };
  if (input.mode === "locked") {
    const locked = input.models.find((model) => model.id === input.lockedModel);
    if (!locked) throw new ModelRoutingError("MODEL_UNAVAILABLE", "The locked model is not currently available through Orbio.");
    if (!eligible(locked, requirements)) throw new ModelRoutingError("MODEL_INCOMPATIBLE", "The locked model does not support this operation's modality, context, or capability requirement.");
    return { model: locked, reasonCode: "locked_model", expectedCostClass: costClass(locked), capabilityScore: capability(locked, input.taskClass), estimated: locked.inputPricePerToken === undefined };
  }
  let candidates = input.models.filter((model) => eligible(model, requirements));
  if (!candidates.length) throw new ModelRoutingError("MODEL_UNAVAILABLE", "No available Orbio model satisfies this operation.");
  if (input.taskClass === "transcription") {
    const dedicated = candidates.filter((model) => /transcri|whisper|asr|stt|chirp|nova/.test(model.id.toLowerCase()));
    if (dedicated.length) candidates = dedicated;
  }
  candidates.sort((a, b) => expectedCost(a) - expectedCost(b) || capability(b, input.taskClass) - capability(a, input.taskClass) || a.id.localeCompare(b.id));
  const model = candidates[0]!;
  return { model, reasonCode: "lowest_cost_adequate", expectedCostClass: costClass(model), capabilityScore: capability(model, input.taskClass), estimated: model.inputPricePerToken === undefined };
}
