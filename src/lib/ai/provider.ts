/**
 * AgentFund's INTERNAL planning model: task analysis.
 *
 * Separate from the user's target model — this only plans and compiles, it
 * never executes the task, and it is never the model the prompt is written for.
 *
 * FAILURE IS NEVER DISGUISED. When the provider fails or returns something
 * unusable, this throws a structured `AiError`. It does not quietly return a
 * heuristic result that the rest of the pipeline would treat as a successful
 * AI analysis: that would make an outage look like a working product, and the
 * user would be shown estimates the model never produced.
 *
 * The heuristic analyzer still exists, but only as a *normalizer*: it supplies
 * plausible values for fields the model omitted, and every returned analysis is
 * labeled with its real source.
 */

import { chat } from "./chatClient";
import { AiError, toAiError } from "./errors";
import { aiAnalysisMaxTokens, aiModel, aiProviderConfigured, missingConfig } from "./env";
import { extractJson } from "./json";
import { heuristicAnalyze } from "./taskAnalyzer";
import { AnalysisValidationError, validateAnalysis } from "@/lib/validation/schemas";
import type { TaskAnalysis } from "@/types";

export interface AnalysisResult {
  analysis: TaskAnalysis;
  /** Truthful provenance. Never "ai" unless the model actually produced it. */
  source: "ai" | "heuristic-normalized";
  model: string;
  requestId: string;
  durationMs: number;
  providerDurationMs?: number;
  attemptCount: number;
}

const SYSTEM_PROMPT = `You are the planning engine inside AgentFund, a budget-aware AI task planner.
You never execute the user's task. You only analyze it and return structured planning metadata.

Analyse the user's request and return ONLY valid JSON with this exact shape:
{
  "taskType": "coding|web-development|research|writing|document-analysis|data-analysis|planning|creative|general",
  "summary": "one sentence describing the goal",
  "complexity": "low|medium|high|very-high",
  "requiredCapabilities": ["..."],
  "estimatedInputTokens": 0,
  "estimatedOutputTokens": 0,
  "expectedIterations": 0,
  "toolRequirements": ["..."],
  "phases": [{"name": "", "description": "", "priority": "essential|recommended|optional", "costWeight": 0.0}],
  "risks": ["..."],
  "scopeAdjustments": ["..."]
}

Rules:
- Return the JSON only. No preamble, no explanation, no markdown fences, no commentary before or after.
- estimatedInputTokens/estimatedOutputTokens are realistic totals across all iterations.
- expectedIterations includes validation and revision passes.
- phases must be ordered and appropriate to the task type, not a fixed template.
- Keep every string short: summary is one sentence, risks and adjustments are short phrases.
- costWeight values across phases should sum to about 1.0.
- Be conservative and realistic. Do not inflate or deflate estimates.`;

/** Re-exported from ./json so every structured path parses identically. */
export { extractJson } from "./json";

/**
 * Analyzes a task with the configured model. FALLBACK PATH only.
 *
 * The normal route is `./combined.ts`, which gets the analysis and the prompt
 * in one request. This is used when the combined call cannot be used: either
 * AGENTFUND_AI_COMBINED=0, or the combined response failed validation.
 *
 * Throws `AiError` on any failure. One retry happens inside `chat()` for
 * transient faults, and at most one further attempt here if the response
 * arrives but fails validation. If it still fails, the error propagates.
 */
export async function analyzeTask(taskDescription: string): Promise<AnalysisResult> {
  if (!aiProviderConfigured()) {
    throw new AiError(
      "BACKEND_NOT_CONFIGURED",
      `AgentFund's model is not configured. Missing: ${missingConfig().join(", ")}.`,
    );
  }

  const baseline = heuristicAnalyze(taskDescription);
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: `Task description:\n${taskDescription}` },
  ];

  let lastError: AiError | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await chat({
        messages,
        jsonMode: true,
        // Small and explicit: the analyser returns one compact JSON object, so
        // a large cap would only buy reasoning and prose AgentFund discards.
        maxTokens: aiAnalysisMaxTokens(),
        temperature: 0.1,
        stage: "task-analysis",
      });
      // A model that hits its output cap mid-JSON returns a truncated object.
      // That is a retryable response problem, not a validation success.
      if (result.finishReason === "length") {
        lastError = new AiError(
          "AI_INVALID_RESPONSE",
          "The planning model ran out of output budget before finishing its analysis.",
          { retryable: true, requestId: result.requestId },
        );
        continue;
      }

      const raw = extractJson(result.content);
      if (raw === null) {
        lastError = new AiError(
          "AI_INVALID_RESPONSE",
          "The planning model returned text that was not valid JSON.",
          { retryable: true, requestId: result.requestId },
        );
        continue;
      }

      try {
        const analysis = validateAnalysis(raw, baseline);
        return {
          analysis,
          source: "ai",
          model: result.model,
          requestId: result.requestId,
          durationMs: result.durationMs,
          providerDurationMs: result.providerDurationMs,
          attemptCount: result.attemptCount,
        };
      } catch (error) {
        if (error instanceof AnalysisValidationError) {
          lastError = new AiError("AI_VALIDATION_FAILED", error.message, {
            retryable: true,
            requestId: result.requestId,
          });
          // Exactly one further attempt, and only because the provider did
          // answer: a differently-worded request can produce valid JSON.
          continue;
        }
        throw error;
      }
    } catch (error) {
      const ai = toAiError(error);
      lastError = ai;
      // Non-transient failures (bad key, unknown model, malformed request) will
      // not improve, so stop instead of spending the second attempt.
      if (!ai.retryable) throw ai;
    }
  }

  throw (
    lastError ??
    new AiError("AI_UNKNOWN_ERROR", "The planning model did not return a usable analysis.")
  );
}

/** The model currently configured for AgentFund's own calls. */
export function configuredModel(): string | undefined {
  return aiModel();
}