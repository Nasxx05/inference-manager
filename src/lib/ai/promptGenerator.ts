import type {
  ClarifyingAnswer,
  CostEstimate,
  ModelConfig,
  OptimizationPreference,
  TaskAnalysis,
} from "@/types";

/**
 * AgentFund's INTERNAL prompt-writing model. It takes everything collected
 * from the user and writes the final prompt, shaped for the specific model
 * the user selected. It never executes the task.
 *
 * Configured server-side only (AI_API_KEY / AI_BASE_URL / AI_MODEL). When it
 * is unavailable or returns something unusable, the caller falls back to the
 * deterministic compiler in promptCompiler.ts.
 */

export interface PromptDraftInput {
  taskDescription: string;
  analysis: TaskAnalysis;
  /** The model the user will actually run the prompt on. */
  targetModel: ModelConfig;
  optimization: OptimizationPreference;
  budget: number;
  cost: Pick<CostEstimate, "minimum" | "maximum" | "recommendedMaximum">;
  clarifyingAnswers: ClarifyingAnswer[];
}

const SECTIONS = [
  "ROLE",
  "OBJECTIVE",
  "CONTEXT",
  "REQUIREMENTS",
  "ASSUMED DEFAULTS",
  "STRUCTURE AND ARCHITECTURE",
  "SCOPE",
  "OUT OF SCOPE",
  "PRIORITIES",
  "EXECUTION STRATEGY",
  "CONSTRAINTS",
  "BUDGET CONSTRAINT",
  "VALIDATION",
  "REVISION POLICY",
  "STOPPING CONDITIONS",
  "OUTPUT FORMAT",
];

const SYSTEM_PROMPT = `You are the prompt-writing engine inside AgentFund, a budget-aware AI task planner.

Your ONLY job is to write a prompt. You never execute, simulate, or solve the user's task.
You write a prompt that the user will later hand to the AI model they selected.

Return the prompt as plain text. No JSON, no code fences, no preamble, no explanation of what
you did. Just the prompt itself.

Hard requirements:
- Start with the section header "ROLE" and end after the "OUTPUT FORMAT" section.
- Use these section headers, each on its own line, in this order:
${SECTIONS.join("\n")}
- Omit "ASSUMED DEFAULTS" if there are no assumed defaults.
- Omit "STRUCTURE AND ARCHITECTURE" if the task produces no buildable artifact
  (for example pure research, writing, planning or analysis).
- Every other section must appear exactly once, even if brief.
- Use "- " for list items. Write in direct, imperative language addressed to the executor.

Quality bar:
- REQUIREMENTS must be concrete and testable, drawn from the user's own wording and their
  confirmed answers. Never restate the original one-liner and stop there.
- "Confirmed by the requester" answers are binding. Weave them into REQUIREMENTS and
  STRUCTURE AND ARCHITECTURE, not into a separate list.
- Assumed defaults are real decisions, not placeholders. State them as decisions to follow,
  and instruct the executor to restate them at the end so the requester can correct them.
- STRUCTURE AND ARCHITECTURE must say how to organise the work: the parts, their
  responsibilities, and how they fit together. Aim for the simplest structure that works.
- Tailor the phrasing to the target model's strengths and limits, as described below.
- Do not invent requirements, features, files, URLs, credentials or data the requester
  never gave you. Placeholder content is fine and should be labelled as placeholder.
- Keep it tight and useful. Around 500-900 words. Never pad.
- Stay under 6000 characters total.`;

function configured(): boolean {
  return Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL);
}

/**
 * This model reasons before it writes, and the reasoning shares the token
 * budget. Observed: ~37k reasoning tokens before ~3k of content. With a low
 * cap the reasoning consumes everything and `content` comes back null, so the
 * cap has to be high enough to leave room for the actual prompt.
 */
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS ?? 16000);

/**
 * Generous, because a reasoning model can take a couple of minutes. The caller
 * keeps its own loading state; on timeout we fall back rather than fail.
 */
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 240000);

function modelNotes(model: ModelConfig): string {
  const tier =
    {
      light: "a lightweight model: keep instructions simple, explicit and sequential. Avoid relying on it to infer unstated intent.",
      standard: "a balanced model: normal direct instruction works well. State non-obvious expectations explicitly.",
      advanced: "a strong model: you can rely on it for multi-step reasoning and architectural judgement, but keep requirements unambiguous.",
      frontier: "a frontier model: you can rely on it to make sound architectural and judgement calls from a well-framed brief.",
    }[model.capabilityTier] ?? "a general model.";

  const context =
    model.contextWindow < 32000
      ? `Its context window is small (${model.contextWindow} tokens), so the prompt must stay compact and self-contained.`
      : `Its context window is ${model.contextWindow} tokens, so there is room for detail, but stay lean.`;

  return `${tier} ${context}`;
}

function answerLines(answers: ClarifyingAnswer[]): string {
  if (answers.length === 0) return "No clarifying questions were asked.";
  return answers
    .map((a) => {
      const prefix = a.answered ? "CONFIRMED (binding)" : "SKIPPED (assume this and restate it)";
      return `${prefix} | ${a.question} | ${a.answer}`;
    })
    .join("\n");
}

function userMessage(input: PromptDraftInput): string {
  const { taskDescription, analysis, targetModel, optimization, budget, cost } = input;

  return [
    "TASK THE REQUESTER DESCRIBED:",
    taskDescription.trim(),
    "",
    "PLANNING ANALYSIS:",
    `Task type: ${analysis.taskType}`,
    `Complexity: ${analysis.complexity}`,
    `Summary: ${analysis.summary}`,
    `Required capabilities: ${analysis.requiredCapabilities.join(", ") || "none specified"}`,
    `Expected iterations: ${analysis.expectedIterations}`,
    analysis.phases.length
      ? `Planned phases:\n${analysis.phases.map((p) => `- ${p.name}: ${p.description} [${p.priority}]`).join("\n")}`
      : "Planned phases: none",
    analysis.risks.length ? `Risks: ${analysis.risks.join("; ")}` : "Risks: none identified",
    "",
    "CLARIFYING ANSWERS:",
    answerLines(input.clarifyingAnswers),
    "",
    "TARGET MODEL THE PROMPT MUST BE WRITTEN FOR:",
    `${targetModel.displayName} (${targetModel.provider})`,
    modelNotes(targetModel),
    "",
    "BUDGET:",
    `Total budget: ${budget} CREDIT`,
    `Planning estimate: ${cost.minimum} - ${cost.maximum} CREDIT`,
    `Recommended maximum: ${cost.recommendedMaximum} CREDIT`,
    `Optimization preference: ${optimization}`,
    "",
    "Write the prompt now.",
  ].join("\n");
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md|text|prompt)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** Keeps the model from returning an essay or a fragment. */
export function acceptablePrompt(prompt: string): boolean {
  if (!prompt || prompt.length < 400 || prompt.length > 12000) return false;
  const mandatory = [
    "ROLE",
    "OBJECTIVE",
    "REQUIREMENTS",
    "SCOPE",
    "CONSTRAINTS",
    "BUDGET CONSTRAINT",
    "VALIDATION",
    "OUTPUT FORMAT",
  ];
  if (!mandatory.every((s) => prompt.includes(s))) return false;
  // Must start at the first section rather than with conversational preamble.
  return prompt.trimStart().startsWith("ROLE");
}

/**
 * Returns a model-written prompt, or null whenever the result cannot be
 * trusted. Callers must fall back rather than surface a broken prompt.
 */
export async function generatePromptWithAI(input: PromptDraftInput): Promise<string | null> {
  if (!configured()) return null;

  const baseUrl = String(process.env.AI_BASE_URL).replace(/\/$/, "");
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage(input) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null };
      }>;
    };
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;

    // A reasoning model that runs out of budget returns null content while
    // reporting finish_reason "length". Treat that as unusable, not empty.
    if (!content || choice?.finish_reason === "length") return null;

    const prompt = stripFences(content);
    return acceptablePrompt(prompt) ? `${prompt}\n` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
