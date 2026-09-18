import type { CapabilityTier, ModelConfig, TaskType } from "@/types";

/**
 * Local model metadata for the MVP.
 *
 * Pricing is expressed in CREDIT per 1M tokens and is STATIC CONFIGURATION,
 * not live data. Replace with a live pricing adapter later; the shape of
 * `ModelConfig` is intentionally provider-agnostic so the rest of the system
 * never depends on these literal values.
 */
export const MODELS: ModelConfig[] = [
  {
    id: "claude-opus",
    displayName: "Claude Opus",
    provider: "Anthropic",
    capabilityTier: "frontier",
    inputPrice: 15,
    outputPrice: 75,
    codingCapability: 95,
    reasoningCapability: 97,
    researchCapability: 92,
    contextWindow: 200000,
  },
  {
    id: "claude-sonnet",
    displayName: "Claude Sonnet",
    provider: "Anthropic",
    capabilityTier: "advanced",
    inputPrice: 3,
    outputPrice: 15,
    codingCapability: 90,
    reasoningCapability: 88,
    researchCapability: 85,
    contextWindow: 200000,
  },
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    provider: "OpenAI",
    capabilityTier: "advanced",
    inputPrice: 2.5,
    outputPrice: 10,
    codingCapability: 87,
    reasoningCapability: 85,
    researchCapability: 82,
    contextWindow: 128000,
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    provider: "OpenAI",
    capabilityTier: "standard",
    inputPrice: 0.15,
    outputPrice: 0.6,
    codingCapability: 68,
    reasoningCapability: 66,
    researchCapability: 64,
    contextWindow: 128000,
  },
  {
    id: "gemini-pro",
    displayName: "Gemini Pro",
    provider: "Google",
    capabilityTier: "advanced",
    inputPrice: 1.25,
    outputPrice: 5,
    codingCapability: 80,
    reasoningCapability: 83,
    researchCapability: 88,
    contextWindow: 1000000,
  },
  {
    id: "gemini-flash",
    displayName: "Gemini Flash",
    provider: "Google",
    capabilityTier: "standard",
    inputPrice: 0.1,
    outputPrice: 0.4,
    codingCapability: 65,
    reasoningCapability: 64,
    researchCapability: 70,
    contextWindow: 1000000,
  },
  {
    id: "deepseek-v3",
    displayName: "DeepSeek V3",
    provider: "DeepSeek",
    capabilityTier: "advanced",
    inputPrice: 0.27,
    outputPrice: 1.1,
    codingCapability: 84,
    reasoningCapability: 79,
    researchCapability: 72,
    contextWindow: 128000,
  },
  {
    id: "deepseek-r1",
    displayName: "DeepSeek R1",
    provider: "DeepSeek",
    capabilityTier: "advanced",
    inputPrice: 0.55,
    outputPrice: 2.19,
    codingCapability: 82,
    reasoningCapability: 93,
    researchCapability: 76,
    contextWindow: 128000,
  },
  {
    id: "llama-small",
    displayName: "Llama 3 Small",
    provider: "Meta",
    capabilityTier: "light",
    inputPrice: 0.06,
    outputPrice: 0.2,
    codingCapability: 52,
    reasoningCapability: 50,
    researchCapability: 48,
    contextWindow: 32000,
  },
];

export const AUTO_MODEL_ID = "auto";

export function getModel(id: string): ModelConfig | undefined {
  return MODELS.find((m) => m.id === id);
}

export function findModelOrThrow(id: string): ModelConfig {
  const model = getModel(id);
  if (!model) throw new Error(`Unknown model id: ${id}`);
  return model;
}

/** Which capability score matters most for a given task type. */
export function capabilityScoreFor(model: ModelConfig, taskType: TaskType): number {
  switch (taskType) {
    case "coding":
    case "web-development":
      return model.codingCapability;
    case "research":
    case "document-analysis":
      return model.researchCapability;
    case "data-analysis":
    case "planning":
      return model.reasoningCapability;
    case "writing":
    case "creative":
      return (model.reasoningCapability + model.codingCapability) / 2;
    default:
      return (model.codingCapability + model.reasoningCapability + model.researchCapability) / 3;
  }
}

/** Minimum capability a model needs to be considered viable for a complexity level. */
export const VIABILITY_THRESHOLD: Record<string, number> = {
  low: 45,
  medium: 62,
  high: 75,
  "very-high": 85,
};

export const TIER_LABEL: Record<CapabilityTier, string> = {
  light: "Light",
  standard: "Medium",
  advanced: "High",
  frontier: "Very high",
};