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
 * This is the ONLY path that produces a prompt. There is no local fallback:
 * a failed attempt is retried, and if it still fails the request errors so
 * the user is told rather than handed a degraded prompt.
 *
 * Configured server-side only (AI_API_KEY / AI_BASE_URL / AI_MODEL).
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

export class PromptGenerationError extends Error {
  /** False for failures that will not improve on a retry (bad key, bad request). */
  readonly retryable: boolean;

  /** The HTTP status, when the failure came from a provider response. */
  readonly status?: number;

  constructor(message: string, retryable = true, status?: number) {
    super(message);
    this.name = "PromptGenerationError";
    this.retryable = retryable;
    this.status = status;
  }
}

export function promptProviderConfigured(): boolean {
  return Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL);
}

/**
 * Read at call time, not module load. The backend is a long-lived process, so
 * a constant captured here would freeze the value at startup and ignore any
 * change to the environment. Reading per call also lets tests set these vars
 * and have them actually take effect.
 *
 * The reasoning shares the token budget: observed ~37k reasoning tokens before
 * ~3k of content. With a low cap the reasoning consumes everything and
 * `content` comes back null, so the default leaves a wide margin.
 */
function maxTokens(): number {
  return Number(process.env.AI_MAX_TOKENS ?? 48000);
}

/**
 * Per-attempt budget. A real prompt takes ~150s end to end, so this must be
 * generous enough for one attempt to finish. Total worst case is bounded by
 * the caller, not by retrying forever.
 */
function timeoutMs(): number {
  return Number(process.env.AI_TIMEOUT_MS ?? 240000);
}

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

/** A real prompt always clears this; anything shorter is a fragment. */
export const MIN_PROMPT_CHARS = 400;

/**
 * Upper bound on a usable prompt. Generous on purpose: a reasoning model can
 * legitimately write a long-but-valid prompt, and rejecting it would discard
 * work that took minutes to produce.
 */
export const MAX_PROMPT_CHARS = 40000;

/** Keeps the model from returning an essay or a fragment. */
export function acceptablePrompt(prompt: string): boolean {
  if (!prompt || prompt.length < MIN_PROMPT_CHARS || prompt.length > MAX_PROMPT_CHARS) return false;
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
  // A stray blank line or markdown heading is tolerated; real prose is not.
  const head = prompt.trimStart();
  return head.startsWith("ROLE") || /^#{0,6}\s*ROLE\b/.test(head);
}

/** Trims anything before the ROLE header instead of discarding the response. */
function trimToStart(prompt: string): string {
  const index = prompt.search(/^#{0,6}\s*ROLE\b/m);
  if (index <= 0) return prompt.trimStart();
  return prompt.slice(index).trimStart();
}

async function attempt(input: PromptDraftInput): Promise<string> {
  const baseUrl = String(process.env.AI_BASE_URL).replace(/\/$/, "");
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        // Low: this model reasons before writing, and a higher temperature
        // lengthens the reasoning chain, which both slows the call down and
        // eats the shared token budget.
        temperature: 0.2,
        max_tokens: maxTokens(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage(input) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Not every 4xx is a bad request. 429 (rate limit) and 408/409 are
      // transient and often clear within a retry or two, and 402 means the
      // account is out of credit rather than misconfigured. Only treat the
      // genuinely terminal codes - 401/403 (bad key) and 400/404/422 (our
      // request is wrong) - as non-retryable, so a rate limit is not reported
      // to the user as a configuration problem.
      const terminal = [400, 401, 403, 404, 422].includes(response.status);
      throw new PromptGenerationError(
        `Prompt model returned ${response.status}`,
        !terminal,
        response.status,
      );
    }

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
    if (!content || choice?.finish_reason === "length") {
      throw new PromptGenerationError("Prompt model ran out of its token budget");
    }

    // Salvage a good body that merely opens with preamble before ROLE.
    const prompt = trimToStart(stripFences(content));
    if (!acceptablePrompt(prompt)) {
      throw new PromptGenerationError("Prompt model returned an unusable structure");
    }
    return `${prompt}\n`;
  } catch (error) {
    if (error instanceof PromptGenerationError) throw error;
    throw new PromptGenerationError("Prompt model request failed");
  } finally {
    clearTimeout(timer);
  }
}

const MAX_ATTEMPTS = 3;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes the prompt with the internal model. Retries up to MAX_ATTEMPTS,
 * because a reasoning model occasionally returns an empty or malformed body.
 * Failures flagged non-retryable (a 4xx) stop immediately. Throws
 * `PromptGenerationError` when no usable prompt can be produced.
 */
export async function generatePrompt(input: PromptDraftInput): Promise<string> {
  if (!promptProviderConfigured()) {
    throw new PromptGenerationError("No prompt-writing model is configured", false);
  }

  let lastError: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    try {
      return await attempt(input);
    } catch (error) {
      lastError = error;
      if (error instanceof PromptGenerationError && !error.retryable) break;
      // Brief pause so a rate limit or transient fault can clear.
      if (i < MAX_ATTEMPTS - 1) await wait(1500 * (i + 1));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new PromptGenerationError("Prompt model request failed");
}
