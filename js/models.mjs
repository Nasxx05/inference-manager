/*
 * AgentFund — Model catalog
 *
 * Single place for every model, provider and price.
 * Prices are USD per 1,000,000 tokens.
 * 1 credit = $0.05, so credits = usd * CREDITS_PER_USD.
 */

export const CREDITS_PER_USD = 20;

export const AUTO_SELECT = "auto";

export const OPTIMIZATION_MODES = [
  "Minimize Cost",
  "Balanced",
  "Prioritize Quality",
];

export const BUDGET_PRESETS = [5, 10, 20, 50];

export const MODELS = [
  {
    id: "claude_opus_4_1",
    provider: "Anthropic",
    name: "Claude Opus 4.1",
    apiModel: "claude-opus-4-1",
    inputPrice: 15,
    outputPrice: 75,
    contextWindow: 200000,
    capability: "High",
    kind: "general",
    strengths: [
      "Long, careful reasoning",
      "Nuanced writing and editing",
      "Large codebases and refactors",
    ],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "claude_sonnet_4_5",
    provider: "Anthropic",
    name: "Claude Sonnet 4.5",
    apiModel: "claude-sonnet-4-5",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 200000,
    capability: "High",
    kind: "general",
    strengths: [
      "Strong everyday coding",
      "Clear explanations",
      "Good balance of speed and depth",
    ],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "claude_haiku_3_5",
    provider: "Anthropic",
    name: "Claude Haiku 3.5",
    apiModel: "claude-haiku-3-5",
    inputPrice: 0.8,
    outputPrice: 4,
    contextWindow: 200000,
    capability: "Medium",
    kind: "fast",
    strengths: ["Very cheap", "Fast", "Good for short, simple tasks"],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "gpt_5",
    provider: "OpenAI",
    name: "GPT-5",
    apiModel: "gpt-5",
    inputPrice: 2.5,
    outputPrice: 10,
    contextWindow: 400000,
    capability: "High",
    kind: "general",
    strengths: [
      "Broad general ability",
      "Good at structured output",
      "Large context window",
    ],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "gpt_5_mini",
    provider: "OpenAI",
    name: "GPT-5 mini",
    apiModel: "gpt-5-mini",
    inputPrice: 0.25,
    outputPrice: 2,
    contextWindow: 400000,
    capability: "Medium",
    kind: "fast",
    strengths: ["Cheap", "Fast", "Fine for small well-defined tasks"],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "gemini_2_5_pro",
    provider: "Google",
    name: "Gemini 2.5 Pro",
    apiModel: "gemini-2.5-pro",
    inputPrice: 1.25,
    outputPrice: 10,
    contextWindow: 1000000,
    capability: "High",
    kind: "general",
    strengths: [
      "Very large context window",
      "Good at research and long documents",
      "Reasonably priced for the capability",
    ],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "gemini_2_5_flash",
    provider: "Google",
    name: "Gemini 2.5 Flash",
    apiModel: "gemini-2.5-flash",
    inputPrice: 0.3,
    outputPrice: 2.5,
    contextWindow: 1000000,
    capability: "Medium",
    kind: "fast",
    strengths: ["Cheap", "Very large context", "Fast"],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "deepseek_v3",
    provider: "DeepSeek",
    name: "DeepSeek V3",
    apiModel: "deepseek-chat",
    inputPrice: 0.27,
    outputPrice: 1.1,
    contextWindow: 128000,
    capability: "Medium",
    kind: "general",
    strengths: ["Very cheap", "Capable on routine code and text"],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "deepseek_r1",
    provider: "DeepSeek",
    name: "DeepSeek R1",
    apiModel: "deepseek-reasoner",
    inputPrice: 0.55,
    outputPrice: 2.19,
    contextWindow: 128000,
    capability: "High",
    kind: "general",
    strengths: [
      "Step-by-step reasoning",
      "Cheaper than other high-capability models",
    ],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "qwen3_coder",
    provider: "Alibaba",
    name: "Qwen3 Coder",
    apiModel: "qwen3-coder-plus",
    inputPrice: 0.6,
    outputPrice: 3,
    contextWindow: 262000,
    capability: "High",
    kind: "coding",
    strengths: [
      "Code generation across many files",
      "Good with commands and tests",
      "Cheap for its capability",
    ],
    available: true,
    updatedAt: "2025-08-05",
  },
  {
    id: "llama_3_3_70b",
    provider: "Meta",
    name: "Llama 3.3 70B",
    apiModel: "llama-3.3-70b",
    inputPrice: 0.5,
    outputPrice: 0.75,
    contextWindow: 128000,
    capability: "Medium",
    kind: "general",
    strengths: ["Very cheap output", "Fine for drafting and summaries"],
    available: true,
    updatedAt: "2025-08-05",
  },
];

export function allModels() {
  return MODELS.slice();
}

export function availableModels() {
  return MODELS.filter((m) => m.available !== false);
}

export function getModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

/** Cost in USD for one pass of input + output tokens. */
export function passCostUsd(model, inputTokens, outputTokens) {
  return (
    (inputTokens / 1_000_000) * model.inputPrice +
    (outputTokens / 1_000_000) * model.outputPrice
  );
}

/** Cost in credits for one pass. */
export function passCostCredits(model, inputTokens, outputTokens) {
  return passCostUsd(model, inputTokens, outputTokens) * CREDITS_PER_USD;
}

/*
 * Tokens for ONE pass.
 *
 * These are deliberately realistic for agentic work, where each pass
 * re-sends a large working context (files, prior output, instructions)
 * and produces a substantial response. A multi-pass build therefore
 * lands in the tens to hundreds of credits, which is what makes the
 * 5 / 10 / 20 / 50 credit budgets meaningful.
 */
const OUTPUT_TOKENS_BY_SIZE = {
  Small: 6000,
  Medium: 14000,
  Large: 26000,
};

const INPUT_TOKENS_BY_CONTEXT = {
  Low: 12000,
  Medium: 35000,
  High: 80000,
};

const COMPLEXITY_FACTOR = {
  Low: 1,
  Medium: 1.4,
  High: 2,
  "Very High": 2.8,
};

/**
 * Rough token usage for one pass, based on the classification.
 * Used by the offline estimator and as a sanity check.
 */
export function estimatePassTokens(classification = {}) {
  const size = OUTPUT_TOKENS_BY_SIZE[classification.outputSize]
    ? classification.outputSize
    : "Medium";
  const context = INPUT_TOKENS_BY_CONTEXT[classification.contextRequirement]
    ? classification.contextRequirement
    : "Medium";
  const complexity = COMPLEXITY_FACTOR[classification.complexity]
    ? classification.complexity
    : "Medium";

  const factor = COMPLEXITY_FACTOR[complexity];
  return {
    inputTokens: Math.round(INPUT_TOKENS_BY_CONTEXT[context] * factor),
    outputTokens: Math.round(OUTPUT_TOKENS_BY_SIZE[size] * factor),
  };
}

export function formatUsdFromCredits(credits) {
  return credits / CREDITS_PER_USD;
}