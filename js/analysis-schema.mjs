/*
 * AgentFund — analysis contract shared by the browser and the server.
 *
 * One model is called a few times, sequentially:
 *   1. analyze the task  -> ANALYSIS_SCHEMA
 *   2. write the prompt  -> { standard, budget_optimized, quality }
 */

export const TASK_TYPES = [
  "Code generation",
  "Code debugging",
  "Code review",
  "Writing or editing",
  "Research or summarization",
  "Data analysis",
  "Design or planning",
  "Automation or scripting",
  "Other",
];

export const COMPLEXITY_LEVELS = ["Low", "Medium", "High", "Very High"];
export const SIZE_LEVELS = ["Small", "Medium", "Large"];
export const CONFIDENCE_LEVELS = ["Low", "Medium", "High"];

export const ANALYSIS_SCHEMA = {
  vague: "boolean — true if the goal is too short or unclear to estimate",
  vagueReason: "string — one short sentence, only if vague is true",
  classification: {
    taskType: `one of: ${TASK_TYPES.join(", ")}`,
    complexity: `one of: ${COMPLEXITY_LEVELS.join(", ")}`,
    outputSize: `one of: ${SIZE_LEVELS.join(", ")}`,
    iterations: "object { low: number, high: number } — how many passes",
    externalToolsLikely: "boolean",
    contextRequirement: "one of: Low, Medium, High",
  },
  executionProfile: {
    passes: "number — expected passes for this task",
    why: "string — one short sentence explaining the pass count",
  },
  cost: {
    low: "number — credits, lowest realistic total",
    high: "number — credits, highest realistic total",
    confidence: `one of: ${CONFIDENCE_LEVELS.join(", ")}`,
  },
  phaseBreakdown: [
    {
      phase: "string — e.g. Requirements, Planning, Implementation, Testing, Review",
      low: "number — credits",
      high: "number — credits",
    },
  ],
  feasibility: {
    status: "one of: fits, fits_with_cuts, does_not_fit",
    summary: "string — one short sentence",
    keep: ["string — parts that stay"],
    skip: ["string — parts that get cut"],
    reducedLow: "number — credits after cuts",
    reducedHigh: "number — credits after cuts",
    minimumBudget: "number — credits needed for a reduced version",
    suggestion: "string — one short sentence",
  },
  modelRecommendation: {
    modelId: "string — id from the supplied catalog",
    reason: "string — one short sentence, capability and cost only",
  },
  modelComparison: [
    {
      modelId: "string — id from the supplied catalog",
      low: "number — credits",
      high: "number — credits",
      capability: "one of: Low, Medium, High",
      note: "string — one short sentence",
    },
  ],
};

export const ANALYSIS_SYSTEM = `You are a planning assistant for AgentFund. You never run the user's task. You only estimate it and describe it.

Rules:
- Always give a cost RANGE (low and high). Never a single number.
- Never claim a model is universally best. Say what it is good at and what it costs.
- Prefer the cheapest model that can still do the job well.
- Costs are in credits. 1 credit = $0.05.
- Be conservative: it is better to warn than to under-estimate.
- Do NOT think out loud and do NOT explain your plan. Output the JSON object immediately as your very first characters.
- Reply with JSON only. No prose, no markdown fences, no code fences, no commentary before or after.

JSON shape:
${JSON.stringify(ANALYSIS_SCHEMA, null, 2)}`;

export function analysisUserPrompt({ goal, requestedModel, budget, optimization, catalog }) {
  return `Task goal:
"""
${goal}
"""

Requested model: ${requestedModel}
Budget: ${budget} credits
Optimization: ${optimization}

Model catalog:
${catalog}

Analyze this task and reply with JSON only.`;
}

export const PROMPT_SYSTEM = `You write prompts that a user will copy into an AI model. You do not run the task.

Every prompt must contain these labeled sections, in this order:
ROLE
OBJECTIVE
REQUIREMENTS (numbered list)
PRIORITY ORDER
CONSTRAINTS
EXECUTION STRATEGY
BUDGET AWARENESS  (must state the credit amount)
STOPPING CONDITION

Style adaptation:
- general models: give more context, ask for step-by-step reasoning
- coding models: mention files, commands and tests
- fast/cheap models: keep it short, narrow the scope, limit revisions

Three variants from the same analysis:
- "standard": the balanced version
- "budget_optimized": narrower scope, fewer passes, same core goal
- "quality": more thorough, more passes, higher budget awareness

Reply with JSON only: { "standard": "...", "budget_optimized": "...", "quality": "..." }`;

export function promptUserPrompt(context) {
  return `Analysis and request context:
${JSON.stringify(context, null, 2)}

Write the three prompt versions. Reply with JSON only.`;
}