/**
 * Combined planning call: task analysis AND prompt generation in ONE request.
 *
 * This is the normal path for /api/plan. Two sequential calls meant paying two
 * provider round trips, two prefills and two latency budgets for what is
 * fundamentally one piece of work: understand the task, then write the prompt
 * for it. Asking for both in a single structured response removes one whole
 * round trip.
 *
 * What this module deliberately does NOT do:
 *
 *  - It never asks the model for money. Cost, recommended maximum, reserve,
 *    feasibility and scope reduction stay local and deterministic, computed
 *    from model metadata plus the token estimates in the analysis. An LLM is
 *    not a calculator and must not invent CREDIT figures.
 *  - It does not decide the target model. It is told which model the prompt is
 *    for, and adapts phrasing to that model's declared capabilities.
 *  - It does not know which model is answering. That comes from
 *    AGENTFUND_AI_MODEL via chatClient.
 *
 * The response is validated before anything else runs. If a model cannot
 * produce both halves reliably, the caller falls back to the two-call path
 * rather than degrading the prompt.
 */

import { chat } from "./chatClient";
import { AiError, toAiError } from "./errors";
import { aiCombinedMaxTokens, aiProviderConfigured, missingConfig } from "./env";
import {
  MAX_PROMPT_CHARS,
  acceptablePrompt,
  missingPromptConcepts,
  stripFences,
  trimToStart,
} from "./prompt";
import { extractJson } from "./json";
import { validateAnalysis } from "@/lib/validation/schemas";
import { heuristicAnalyze } from "./taskAnalyzer";
import type {
  ClarifyingAnswer,
  ModelConfig,
  OptimizationPreference,
  TaskAnalysis,
} from "@/types";

export interface CombinedInput {
  taskDescription: string;
  /** The model the user will run the prompt on. Never Promgent's own model. */
  targetModel: ModelConfig;
  optimization: OptimizationPreference;
  budget: number;
  clarifyingAnswers: ClarifyingAnswer[];
  /**
   * The resolved scope the prompt must describe. The prompt is written once, so
   * it must be written for the FINAL scope — otherwise the UI can show
   * "optimized scope applied" while the prompt still describes the original,
   * larger request.
   */
  resolvedScope?: { included: string[]; deferred: string[] };
  /**
   * Reference understanding, when the user supplied an image or website URL.
   * Omitted entirely for text-only requests so the writer sees no reference
   * block at all.
   */
  referenceBrief?: string;
}

export interface CombinedResult {
  analysis: TaskAnalysis;
  prompt: string;
  promptSummary: string;
  model: string;
  requestId: string;
  /** Provider round-trip time for the single call. */
  durationMs: number;
  providerDurationMs?: number;
  /** Attempts actually sent for this call (1, or 2 after one retry). */
  attemptCount: number;
}

const COMBINED_SYSTEM = `You are the planning and prompt-writing engine inside Promgent.

You do two things in ONE response:
1. Analyse the task.
2. Write the final prompt for the model named below.

You never execute, simulate or solve the user's task. You never compute money, prices,
costs, budgets or fees — another part of the system does that deterministically.

Return ONLY valid JSON, no fences, no commentary, in this exact shape:
{
  "taskAnalysis": {
    "taskType": "coding|web-development|research|writing|document-analysis|data-analysis|planning|creative|general",
    "summary": "one sentence",
    "complexity": "low|medium|high|very-high",
    "requiredCapabilities": ["..."],
    "estimatedInputTokens": 0,
    "estimatedOutputTokens": 0,
    "expectedIterations": 0,
    "toolRequirements": ["..."],
    "phases": [{"name": "", "description": "", "priority": "essential|recommended|optional", "costWeight": 0.0}],
    "risks": ["..."],
    "scopeAdjustments": ["..."],
    "effort": {
      "effortLevel": "low|medium|high|very-high|extreme",
      "effortScore": 0,
      "requirementCount": 0,
      "criticalRequirementCount": 0,
      "optionalRequirementCount": 0,
      "estimatedIterations": {"min": 0, "max": 0},
      "implementationSize": 0,
      "contextOverhead": 0,
      "toolOverhead": 0,
      "revisionLoad": 0
    },
    "requirementProfile": {
      "codingRequirement": 0,
      "reasoningRequirement": 0,
      "researchRequirement": 0,
      "contextRequirement": 0,
      "structuredOutputRequirement": 0
    },
    "phaseTokens": {"<phase name>": {"input": 0, "output": 0}},
    "confidence": "low|medium|high",
    "costDrivers": ["..."],
    "scope": {
      "essential": ["..."],
      "optional": ["..."],
      "reducible": ["..."],
      "deferred": ["..."]
    }
  },
  "generatedPrompt": "the full prompt text",
  "promptSummary": "one short sentence describing the prompt"
}

Analysis rules:
- estimatedInputTokens/estimatedOutputTokens are realistic totals across all iterations.
- expectedIterations includes validation and revision passes.
- phases must suit the task type, ordered, with costWeight summing to about 1.0.
- scope lists must be concrete features, not categories. "essential" is what must ship
  for the task to be complete; "deferred" is what can wait; "reducible" is what can be
  simplified into a prototype.
- Keep every analysis string short. Put the detail in generatedPrompt, not here.

Workload rules (these drive the cost estimate, so be honest and specific):
- effortScore is 0-100 for the TOTAL work implied. A one-page site is 10-25. A portfolio
  site is 30-45. A RAG pipeline with ingestion, embeddings, retrieval and evaluation is
  60-80. A full multi-layer SaaS platform is 80-100. Never compress a large system into
  a small score.
- requirementCount counts DISTINCT substantial requirements, not words. "auth, database,
  API, payments, dashboard, analytics" is 6, not 1. A multi-feature system is a
  collection of tasks, not one task.
- estimatedIterations is the realistic plan→generate→test→debug→revise loop: 1-2 for
  trivial work, 2-4 medium, 4-7 complex, 6-12 for very complex systems.
- implementationSize: how much artifact is produced (0 = pure advice, 100 = large codebase).
- contextOverhead: how much reading, research or document context is needed.
- toolOverhead: external integrations, tooling, dependency and environment work.
- revisionLoad: expected debugging, integration failures, tuning and repair.
- requirementProfile scores what capability the task DEMANDS of a model (0-100), not what
  any particular model has.
- phaseTokens: per-phase input/output token estimates. Implementation phases are
  output-heavy; research phases are input-heavy.
- confidence: "low" when the brief is vague or huge, "high" when small and well-defined.
- costDrivers: 2-5 short phrases explaining what makes this task expensive or cheap.

Prompt rules:
- generatedPrompt must start with the header ROLE and end after OUTPUT FORMAT.
- Use these headers on their own lines, in this order:
  ROLE, OBJECTIVE, CONTEXT, REQUIREMENTS, ASSUMED DEFAULTS, STRUCTURE AND ARCHITECTURE,
  SCOPE, OUT OF SCOPE, PRIORITIES, EXECUTION STRATEGY, CONSTRAINTS, BUDGET CONSTRAINT,
  VALIDATION, REVISION POLICY, STOPPING CONDITIONS, OUTPUT FORMAT
- Omit ASSUMED DEFAULTS when nothing was skipped. Omit STRUCTURE AND ARCHITECTURE when
  the task produces no buildable artifact.
- Every other header appears exactly once, even if brief. Use "- " for list items.
- REQUIREMENTS must be concrete and testable, drawn from the requester's wording and
  confirmed answers. Confirm binding answers into REQUIREMENTS, not a separate list.
- Address the executor directly and imperatively. Do not explain what you are doing.
- Do not invent features, files, URLs, credentials or data the requester never gave.
- If a RESOLVED SCOPE block is present, it is binding. Describe only what is in
  scope; put every deferred item under OUT OF SCOPE. Never reintroduce deferred
  work as an optional enhancement — that would contradict the plan the user sees.
- Keep it tight and useful, around 500-900 words. Never pad.`;

function modelNotes(model: ModelConfig): string {
  const tier =
    {
      light:
        "a lightweight model: keep instructions simple, explicit and sequential. Do not rely on it to infer unstated intent.",
      standard:
        "a balanced model: normal direct instruction works well. State non-obvious expectations explicitly.",
      advanced:
        "a strong model: it can handle multi-step reasoning and architectural judgement, but keep requirements unambiguous.",
      frontier:
        "a frontier model: it can make sound architectural and judgement calls from a well-framed brief.",
    }[model.capabilityTier] ?? "a general model.";

  const context =
    model.contextWindow < 32000
      ? `Its context window is small (${model.contextWindow} tokens), so keep the prompt compact and self-contained.`
      : `Its context window is ${model.contextWindow} tokens, so there is room for detail, but stay lean.`;

  return `${tier} ${context}`;
}

function answerLines(answers: ClarifyingAnswer[]): string {
  if (answers.length === 0) return "No clarifying questions were asked.";
  return answers
    .map((a) => {
      const prefix = a.answered ? "CONFIRMED (binding)" : "SKIPPED (assume and restate it)";
      return `${prefix} | ${a.question} | ${a.answer}`;
    })
    .join("\n");
}

/**
 * Builds the single user message.
 *
 * Compact on purpose: the task, the answers, the target model and the budget
 * each appear exactly once. Duplicating any of them costs tokens and latency
 * without improving the result.
 */
function userMessage(input: CombinedInput): string {
  const {
    taskDescription,
    targetModel,
    optimization,
    budget,
    clarifyingAnswers,
    resolvedScope,
    referenceBrief,
  } = input;

  const blocks = ["TASK:", taskDescription.trim(), "", "ANSWERS:", answerLines(clarifyingAnswers)];

  /**
   * The resolved scope is binding for the prompt.
   *
   * When scope optimization has been applied, deferred work must be absent from
   * the prompt entirely — not merely mentioned as optional. A prompt still
   * saying "implement Stripe payments" while the UI says payments are deferred
   * is a contradiction the user would act on and overrun their budget.
   */
  if (resolvedScope) {
    blocks.push(
      "",
      "RESOLVED SCOPE — the prompt must describe exactly this, and nothing more:",
      "IN SCOPE:",
      ...resolvedScope.included.map((item) => `- ${item}`),
      "",
      "EXPLICITLY DEFERRED — do not include, mention as optional, or hint at:",
      ...resolvedScope.deferred.map((item) => `- ${item}`),
      "",
      "Write SCOPE from the IN SCOPE list and OUT OF SCOPE from the deferred list.",
    );
  }

  /**
   * The reference is translated into instructions, not pointed at.
   *
   * The prompt may be copied to a model that never sees the image or URL, so
   * "make it like the reference" would be useless. The brief states the
   * characteristics to reproduce instead.
   */
  if (referenceBrief) {
    blocks.push(
      "",
      "DESIGN REFERENCE — reproduce these characteristics; you cannot see the original:",
      referenceBrief,
      "",
      "Translate the reference into concrete instructions (layout hierarchy, typography " +
        "direction, spacing, colour direction, component patterns). Produce an ORIGINAL " +
        "implementation inspired by it: do not copy proprietary copy, logos or assets.",
    );
  }

  blocks.push(
    "",
    "TARGET MODEL TO WRITE THE PROMPT FOR:",
    `${targetModel.displayName} (${targetModel.provider})`,
    modelNotes(targetModel),
    "",
    `BUDGET: ${budget} CREDIT (planning figure only — do not compute costs).`,
    `OPTIMIZATION: ${optimization}`,
  );

  return blocks.join("\n");
}

function parseCombined(raw: unknown): {
  analysis: TaskAnalysis;
  prompt: string;
  promptSummary: string;
} {
  if (!raw || typeof raw !== "object") {
    throw new AiError("AI_INVALID_RESPONSE", "The model returned no usable JSON object.");
  }
  const value = raw as Record<string, unknown>;

  const analysisRaw = value.taskAnalysis ?? value.analysis;
  if (!analysisRaw || typeof analysisRaw !== "object") {
    throw new AiError("AI_VALIDATION_FAILED", "The response is missing taskAnalysis.");
  }

  const rawPrompt = value.generatedPrompt ?? value.prompt;
  if (typeof rawPrompt !== "string" || !rawPrompt.trim()) {
    throw new AiError("AI_VALIDATION_FAILED", "The response is missing generatedPrompt.");
  }

  // Heuristic values fill only the fields the model omitted; every analysis
  // field is still validated, and provenance stays truthful because the
  // analysis is only accepted when the model actually supplied it.
  const baseline = heuristicAnalyze(String(value.taskDescription ?? ""));
  const analysis = validateAnalysis(analysisRaw, baseline);

  const prompt = trimToStart(stripFences(rawPrompt));
  if (!acceptablePrompt(prompt)) {
    const missing = missingPromptConcepts(prompt);
    throw new AiError(
      "AI_VALIDATION_FAILED",
      missing.length
        ? `The generated prompt is missing required sections: ${missing.join(", ")}.`
        : `The generated prompt is not a usable Promgent prompt (${prompt.length} chars, valid range 400-${MAX_PROMPT_CHARS}).`,
    );
  }

  const summary =
    typeof value.promptSummary === "string" && value.promptSummary.trim()
      ? value.promptSummary.trim()
      : analysis.summary;

  return { analysis, prompt: `${prompt}\n`, promptSummary: summary };
}

/**
 * Runs the combined planning call.
 *
 * At most two attempts: the initial call, plus exactly one controlled repair
 * request when the response arrives but fails validation. Transport and
 * transient failures are retried once inside `chat()`, and never stack with the
 * repair attempt — so the maximum is two sends, never three.
 */
export async function generatePlan(input: CombinedInput): Promise<CombinedResult> {
  if (!aiProviderConfigured()) {
    throw new AiError(
      "BACKEND_NOT_CONFIGURED",
      `Promgent's model is not configured. Missing: ${missingConfig().join(", ")}.`,
    );
  }

  const messages = [
    { role: "system" as const, content: COMBINED_SYSTEM },
    { role: "user" as const, content: userMessage(input) },
  ];

  let lastError: AiError | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await chat({
        messages,
        jsonMode: true,
        maxTokens: aiCombinedMaxTokens(),
        temperature: 0.2,
        stage: "combined-analysis-and-prompt",
      });

      if (result.finishReason === "length") {
        lastError = new AiError(
          "AI_INVALID_RESPONSE",
          "The model ran out of output budget before finishing the analysis and prompt.",
          { retryable: true, requestId: result.requestId },
        );
        continue;
      }

      const raw = extractJson(result.content);
      if (raw === null) {
        lastError = new AiError(
          "AI_INVALID_RESPONSE",
          "The model returned text that was not valid JSON.",
          { retryable: true, requestId: result.requestId },
        );
        continue;
      }

      const parsed = parseCombined(raw);
      return {
        ...parsed,
        model: result.model,
        requestId: result.requestId,
        durationMs: result.durationMs,
        providerDurationMs: result.providerDurationMs,
        attemptCount: result.attemptCount,
      };
    } catch (error) {
      const ai = toAiError(error);
      lastError = ai;
      // Terminal failures (bad key, unknown model, malformed request) cannot
      // improve, so stop instead of spending a second send.
      if (!ai.retryable) throw ai;
      // Validation failures are repairable and continue the loop; transport
      // failures were already retried inside chat() and are thrown.
      if (ai.code !== "AI_VALIDATION_FAILED" && ai.code !== "AI_INVALID_RESPONSE") throw ai;
    }
  }

  throw lastError ?? new AiError("AI_UNKNOWN_ERROR", "The model did not return a usable plan.");
}