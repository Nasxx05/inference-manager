/**
 * AgentFund's INTERNAL prompt-writing model.
 *
 * It takes everything collected from the user and writes the final prompt,
 * shaped for the specific model the user selected. It never executes the task.
 *
 * This is the ONLY path that produces a prompt. There is no local compiler and
 * no degraded substitute: a failed attempt is retried once, and if it still
 * fails the request errors so the user is told rather than handed something
 * weaker than they asked for.
 *
 * All provider access goes through ./chatClient, so nothing here knows which
 * model or provider is configured. Writing is generic; only the *content* is
 * tailored, based on the target model's declared capabilities.
 */

import { chat } from "./chatClient";
import { AiError, toAiError } from "./errors";
import { aiMaxTokens, aiProviderConfigured, missingConfig } from "./env";
import type {
  ClarifyingAnswer,
  CostEstimate,
  ModelConfig,
  OptimizationPreference,
  TaskAnalysis,
} from "@/types";

export interface PromptDraftInput {
  taskDescription: string;
  analysis: TaskAnalysis;
  /** The model the user will actually run the prompt on. Never AgentFund's own. */
  targetModel: ModelConfig;
  optimization: OptimizationPreference;
  budget: number;
  cost: Pick<CostEstimate, "minimum" | "maximum" | "recommendedMaximum">;
  clarifyingAnswers: ClarifyingAnswer[];
}

export interface PromptResult {
  prompt: string;
  model: string;
  requestId: string;
  durationMs: number;
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

export function promptProviderConfigured(): boolean {
  return aiProviderConfigured();
}

/**
 * Notes for the writer, derived from the target model's declared metadata.
 *
 * Generic on purpose: capability tier and context window are properties every
 * model has, so the phrasing adapts without branching on a model id.
 */
function modelNotes(model: ModelConfig): string {
  const tier =
    {
      light:
        "a lightweight model: keep instructions simple, explicit and sequential. Avoid relying on it to infer unstated intent.",
      standard:
        "a balanced model: normal direct instruction works well. State non-obvious expectations explicitly.",
      advanced:
        "a strong model: you can rely on it for multi-step reasoning and architectural judgement, but keep requirements unambiguous.",
      frontier:
        "a frontier model: you can rely on it to make sound architectural and judgement calls from a well-framed brief.",
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
      ? `Planned phases:\n${analysis.phases
          .map((p) => `- ${p.name}: ${p.description} [${p.priority}]`)
          .join("\n")}`
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
 * Upper bound on a usable prompt. Generous on purpose: a long-but-valid prompt
 * should not be discarded, but a runaway response is not a prompt.
 */
export const MAX_PROMPT_CHARS = 40000;

/**
 * Section concepts that must be present.
 *
 * Checked case-insensitively and allowing internal whitespace differences:
 * "Outof Scope" or "OUT OF SCOPE" both pass. A minor formatting difference must
 * not reject a valid prompt, but the required concepts must all exist.
 */
export const REQUIRED_CONCEPTS = [
  "role",
  "objective",
  "context",
  "requirements",
  "scope",
  "outofscope",
  "priorities",
  "executionstrategy",
  "constraints",
  // Required in its own right, not merely as part of "constraints": the budget
  // is the point of AgentFund, and a prompt that never states it is not an
  // AgentFund prompt.
  "budgetconstraint",
  "validation",
  "revisionpolicy",
  "stoppingconditions",
  "outputformat",
] as const;

/** Collapses case and spacing so header formatting can vary. */
export function sectionKey(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Keeps the model from returning an essay or a fragment. */
export function acceptablePrompt(prompt: string): boolean {
  if (!prompt || prompt.length < MIN_PROMPT_CHARS || prompt.length > MAX_PROMPT_CHARS) {
    return false;
  }
  const normalized = sectionKey(prompt);
  if (!REQUIRED_CONCEPTS.every((concept) => normalized.includes(concept))) return false;
  // Must start at the first section rather than with conversational preamble.
  const head = prompt.trimStart();
  return head.startsWith("ROLE") || /^#{0,6}\s*ROLE\b/.test(head);
}

/** Trims anything before the ROLE header instead of discarding the response. */
function trimToStart(prompt: string): string {
  const index = prompt.search(/^#{0,6}\s*ROLE\b/m);
  if (index <= 0) return prompt.trimStart();
  return prompt.slice(index).trimStart();
}

type Attempt =
  | { ok: true; result: PromptResult }
  | {
      ok: false;
      error: AiError;
      /**
       * True when the provider answered but the content was unusable. False
       * when the failure came out of `chat()`, which has already spent its one
       * retry on transport, timeouts and transient statuses.
       */
      contentLevel: boolean;
    };

async function attempt(input: PromptDraftInput): Promise<Attempt> {
  let result;
  try {
    result = await chat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage(input) },
      ],
      maxTokens: aiMaxTokens(),
      temperature: 0.2,
    });
  } catch (error) {
    // chat() already retried once for transient faults. Retrying here too would
    // quietly turn "one retry" into several, so this is final.
    return { ok: false, error: toAiError(error), contentLevel: false };
  }

  // A model that exhausts its budget reports finish_reason "length" and returns
  // a truncated prompt. That is unusable, not merely short.
  if (result.finishReason === "length") {
    return {
      ok: false,
      contentLevel: true,
      error: new AiError(
        "AI_INVALID_RESPONSE",
        "The prompt model ran out of output budget before finishing the prompt.",
        { retryable: true, requestId: result.requestId },
      ),
    };
  }

  const prompt = trimToStart(stripFences(result.content));
  if (!acceptablePrompt(prompt)) {
    return {
      ok: false,
      contentLevel: true,
      error: new AiError(
        "AI_VALIDATION_FAILED",
        "The prompt model returned something that is not a usable AgentFund prompt.",
        { retryable: true, requestId: result.requestId },
      ),
    };
  }

  return { ok: true, result: { prompt: `${prompt}\n`, ...result } };
}

/**
 * Writes the prompt with the configured model.
 *
 * At most two provider round trips in total. `chat()` spends its single retry
 * on transport, timeout and transient-status failures; this spends one further
 * attempt only when the provider replied with content that failed validation.
 * The two never stack, so a failing provider is never hammered.
 *
 * Throws `AiError` when no usable prompt can be produced: the caller reports a
 * real failure rather than returning a degraded prompt.
 */
export async function generatePrompt(input: PromptDraftInput): Promise<PromptResult> {
  if (!aiProviderConfigured()) {
    throw new AiError(
      "BACKEND_NOT_CONFIGURED",
      `AgentFund's model is not configured. Missing: ${missingConfig().join(", ")}.`,
    );
  }

  const first = await attempt(input);
  if (first.ok) return first.result;
  // Transport-level failures were already retried once inside chat().
  if (!first.contentLevel) throw first.error;

  const second = await attempt(input);
  if (second.ok) return second.result;
  throw second.error;
}
