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

function capability(model: OrbioCatalogueModel, task: ModelTaskClass): number {
  const id = model.id.toLowerCase();
  let score = 62;
  if (/opus|gpt-5|gpt-6|sonnet|glm-5|deepseek-v3|deepseek-r1|gemini-3/.test(id)) score += 22;
  if (/flash|mini|haiku|nano|small|lite/.test(id)) score -= task === "light_chat" || task === "explanation" ? 2 : 10;
  if (/preview|free/.test(id)) score -= 5;
  if (task === "transcription" && /transcri|whisper|asr|stt|chirp|nova/.test(id)) score += 30;
  if ((task === "code_review" || task === "implementation_prompt") && /coder|code|claude|gpt|deepseek|qwen/.test(id)) score += 8;
  if (task === "large_repository_review" && model.contextLength >= 128_000) score += 8;
  if (task === "structured_project_update" && /gpt|gemini|claude|deepseek|qwen|glm/.test(id)) score += 5;
  return Math.max(0, Math.min(100, score));
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
  return input.requiredModalities.every((modality) => model.inputModalities.includes(modality))
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
