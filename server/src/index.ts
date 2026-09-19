/**
 * Promgent backend.
 *
 * This service owns the LLM credentials and does the slow work: task analysis
 * and prompt generation. The Next.js frontend on Vercel holds no credentials
 * and never calls the model provider; the browser calls this service directly.
 *
 * The provider layer is model-agnostic: nothing here knows which model is in
 * use. Configure on Render:
 *
 *   AGENTFUND_AI_BASE_URL, AGENTFUND_AI_API_KEY, AGENTFUND_AI_MODEL
 *   (optional: AGENTFUND_AI_MAX_TOKENS, AGENTFUND_AI_ANALYSIS_MAX_TOKENS,
 *              AGENTFUND_AI_PROMPT_MAX_TOKENS, AGENTFUND_AI_TIMEOUT_MS,
 *              AGENTFUND_AI_COMBINED, AGENTFUND_AI_FALLBACK_MODEL,
 *              ALLOWED_ORIGINS)
 *
 * Changing AGENTFUND_AI_MODEL is enough to switch the internal model.
 *
 * LLM call budget for a completed task: ONE.
 *
 *   1. /api/clarify  local classification only — no LLM call
 *   2. /api/plan     one combined call returning analysis AND prompt,
 *                    falling back to two calls only if the model cannot
 *                    produce both halves together.
 *
 * Cost, feasibility, scope optimization and model recommendation are all local
 * calculations, so they cost no LLM time at all.
 */

import cors from "cors";
import express from "express";
import { loadLocalEnv } from "./loadEnv";
import { AiError, newRequestId, toAiError } from "@/lib/ai/errors";
import {
  ENV,
  aiCombinedMaxTokens,
  aiModel,
  aiProviderConfigured,
  legacyMaxTokensPresent,
  usingLegacyEnvNames,
} from "@/lib/ai/env";
import { logTiming } from "@/lib/ai/chatClient";
import { aiHealth, backendHealth, simpleAiTest, tokenBudgets } from "@/lib/ai/health";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { buildPlanWithMetrics } from "@/lib/planner";
import { selectQuestions } from "@/lib/clarifier";
import { parseBudget, parseOptimization } from "@/lib/validation/schemas";
import type { ClarifyingQuestion, OptimizationPreference, TaskType } from "@/types";

// Must run before any env value is read below, and before PORT or the CORS
// allow-list are captured. On the host this is a no-op: the variables already
// exist, and the loader never overwrites them.
const envFilesLoaded = loadLocalEnv();

const app = express();

const PORT = Number(process.env.PORT ?? 10000);
const MAX_QUESTIONS = 12;
const MAX_ANSWER_LENGTH = 2000;
const MAX_TASK_LENGTH = 8000;

/**
 * Origins allowed to call this API from a browser, comma separated.
 *
 * Unset means open, which is convenient locally but wrong in production: an
 * unrestricted API is callable from any page. In production a missing
 * allow-list is reported loudly at startup and through /health.
 */
function allowedOrigins(): string[] | null {
  const raw = (process.env.ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : null;
}

const allowList = allowedOrigins();
const isProduction = (process.env.NODE_ENV ?? "").toLowerCase() === "production";

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and server-to-server calls have no Origin header.
      if (!origin) return callback(null, true);
      if (!allowList) return callback(null, true);
      const normalized = origin.trim().replace(/\/+$/, "");
      return callback(null, allowList.includes(normalized));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(express.json({ limit: "1mb" }));

/* -------------------------------------------------------------------------- */
/* Timing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One line per stage, plus a total.
 *
 * The point is to make it obvious where time goes: `clarify` is local and
 * should be ~0ms, and the LLM work is either one combined stage or the two
 * fallback stages. If the total is dominated by one of them, the log says which.
 */
function logStage(
  requestId: string,
  stage: "clarify" | "combined-analysis-and-prompt" | "task-analysis" | "prompt-generation" | "total",
  durationMs: number,
  success: boolean,
  detail = "",
): void {
  console.log(
    `[stage] ts=${new Date().toISOString()} requestId=${requestId} stage=${stage} ` +
      `durationMs=${durationMs} success=${success}${detail ? ` ${detail}` : ""}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Render pings this to decide whether the instance is healthy. It must never
 * depend on the provider being reachable, or a provider outage would cause
 * Render to kill a perfectly good instance.
 */
app.get("/health", (_request, response) => {
  response.json({
    success: true,
    data: { ...backendHealth(), budgets: { ...tokenBudgets(), combined: aiCombinedMaxTokens() } },
  });
});

/**
 * Checks the AI provider connection end to end: configuration, model
 * availability, then a trivial echo request.
 *
 * Always 200 so the diagnostic body is readable; consult `status`, `error.code`
 * and `modelAvailable`. Nothing sensitive is returned.
 */
app.get("/health/ai", async (_request, response) => {
  try {
    response.json({ success: true, data: await aiHealth() });
  } catch (error) {
    const ai = toAiError(error);
    response.json({
      success: true,
      data: {
        ...(await aiHealth()),
        error: { code: ai.code, message: ai.message, requestId: ai.requestId },
      },
    });
  }
});

/**
 * The trivial connectivity test on its own.
 *
 * Separates "the provider connection is broken" from "the planner is broken":
 * if this succeeds but /api/plan fails, the fault is in prompt generation.
 * It uses a 32-token cap, so it is fast and cheap.
 */
app.get("/health/ai/test", async (_request, response) => {
  const result = await simpleAiTest();
  response.json({
    success: result.ok,
    data: {
      expected: "AGENTFUND_TEST_OK",
      ok: result.ok,
      model: result.model ?? aiModel() ?? null,
      requestId: result.requestId ?? null,
      durationMs: result.durationMs ?? null,
      // Echoed only when it differs from the expected string, and truncated:
      // enough to see what came back without dumping model output.
      received: result.ok ? "AGENTFUND_TEST_OK" : (result.raw ?? null),
    },
    ...(result.error ? { error: result.error } : {}),
  });
});

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

function userFacingMessage(ai: AiError): string {
  switch (ai.code) {
    case "BACKEND_NOT_CONFIGURED":
      return "The Promgent backend is not configured with a model. Set AGENTFUND_AI_API_KEY, AGENTFUND_AI_BASE_URL and AGENTFUND_AI_MODEL, then restart.";
    case "AI_AUTH_FAILED":
      return "The AI provider rejected the credentials. Check that AGENTFUND_AI_API_KEY is correct and complete, with no trailing space or newline.";
    case "AI_MODEL_UNAVAILABLE":
      return "The configured model is not available on this provider. Check AGENTFUND_AI_MODEL against the provider's model list, or set AGENTFUND_AI_FALLBACK_MODEL.";
    case "AI_RATE_LIMITED":
      return "The AI provider is rate limiting requests. Wait a moment and try again.";
    case "AI_PROVIDER_UNREACHABLE":
      return "The AI provider could not be reached. It may be temporarily unavailable — please try again.";
    case "AI_TIMEOUT":
      return "The AI provider took too long to respond. Please try again.";
    case "AI_INVALID_RESPONSE":
    case "AI_VALIDATION_FAILED":
      return "The AI provider returned a response Promgent could not use. Please try again.";
    default:
      return "Something went wrong while planning your task. Please try again.";
  }
}

/** Maps an AiError onto the documented error contract. */
function errorResponse(ai: AiError, status: number) {
  return {
    status,
    body: {
      success: false,
      error: {
        code: ai.code,
        message: userFacingMessage(ai),
        requestId: ai.requestId,
      },
    },
  };
}

const VALID_TASK_TYPES: TaskType[] = [
  "coding",
  "web-development",
  "research",
  "writing",
  "document-analysis",
  "data-analysis",
  "planning",
  "creative",
  "general",
];

function asTaskType(value: unknown): TaskType | null {
  return VALID_TASK_TYPES.includes(value as TaskType) ? (value as TaskType) : null;
}

/**
 * Only the question definitions are trusted from the client, and only enough
 * of them to pair answers with defaults. Anything malformed is dropped.
 */
function parseClarifyingQuestions(value: unknown): ClarifyingQuestion[] {
  if (!Array.isArray(value)) return [];

  const out: ClarifyingQuestion[] = [];
  for (const raw of value.slice(0, MAX_QUESTIONS)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = String(entry.id ?? "").trim();
    const question = String(entry.question ?? "").trim();
    const defaultValue = String(entry.defaultValue ?? "").trim();
    if (!id || !question || !defaultValue) continue;
    out.push({
      id,
      question,
      defaultValue,
      ...(entry.singleSelect === true ? { singleSelect: true } : {}),
    });
  }
  return out;
}

function parseClarifyingResponses(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    out[String(key).slice(0, 64)] = raw.slice(0, MAX_ANSWER_LENGTH);
  }
  return out;
}

/** Shared validation for the fields every planning request needs. */
function validatePlanInput(payload: Record<string, unknown>):
  | { ok: true; taskDescription: string; optimization: OptimizationPreference; budget: number }
  | { ok: false; message: string } {
  const taskDescription = String(payload.taskDescription ?? "").trim();
  if (!taskDescription) {
    return { ok: false, message: "Describe what you want to accomplish before continuing." };
  }
  if (taskDescription.length > MAX_TASK_LENGTH) {
    return { ok: false, message: "Task description is too long." };
  }

  const budget = parseBudget(payload.budget);
  if (budget === null) {
    return { ok: false, message: "Enter a valid CREDIT amount greater than zero." };
  }

  const optimization = parseOptimization(payload.optimization) as OptimizationPreference | null;
  if (!optimization) {
    return { ok: false, message: "Select an optimization preference." };
  }

  return { ok: true, taskDescription, optimization, budget };
}

/**
 * Returns the clarifying questions for a task. NO LLM CALL.
 *
 * Classification is local and deterministic. The only thing this step needs is
 * a task type good enough to pick a relevant question set; the full AI analysis
 * happens once in /api/plan, after the user answers or skips.
 */
app.post("/api/clarify", async (request, response) => {
  const started = Date.now();
  const requestId = newRequestId();
  const payload = (request.body ?? {}) as Record<string, unknown>;

  const taskDescription = String(payload.taskDescription ?? "").trim();
  if (!taskDescription) {
    logStage(requestId, "clarify", Date.now() - started, false);
    return response.status(400).json({
      success: false,
      error: {
        code: "AI_VALIDATION_FAILED",
        message: "Describe what you want to accomplish before continuing.",
        requestId,
      },
    });
  }
  if (taskDescription.length > MAX_TASK_LENGTH) {
    logStage(requestId, "clarify", Date.now() - started, false);
    return response.status(400).json({
      success: false,
      error: {
        code: "AI_VALIDATION_FAILED",
        message: "Task description is too long.",
        requestId,
      },
    });
  }

  // Local only: classify from the task text, or trust the client's type when it
  // supplies a valid one. No provider call, so this returns immediately even
  // when the provider is down or unconfigured.
  let taskType = asTaskType(payload.taskType);
  if (!taskType) {
    taskType = heuristicAnalyze(taskDescription).taskType;
  }

  const questions = selectQuestions(taskDescription, taskType);
  logStage(requestId, "clarify", Date.now() - started, true, `taskType=${taskType}`);

  return response.json({ success: true, data: { taskType, questions } });
});

/**
 * Builds the full plan. Normally ONE LLM call returning the analysis and the
 * prompt together, with an automatic two-call fallback. Everything after the
 * call is local.
 */
app.post("/api/plan", async (request, response) => {
  const totalStarted = Date.now();
  const requestId = newRequestId();
  const payload = (request.body ?? {}) as Record<string, unknown>;

  const input = validatePlanInput(payload);
  if (!input.ok) {
    logStage(requestId, "total", Date.now() - totalStarted, false);
    return response.status(400).json({
      success: false,
      error: { code: "AI_VALIDATION_FAILED", message: input.message, requestId },
    });
  }

  try {
    const built = await buildPlanWithMetrics({
      taskDescription: input.taskDescription,
      modelId: String(payload.modelId ?? "").trim() || "auto",
      optimization: input.optimization,
      budget: input.budget,
      applyOptimizedScope: payload.applyOptimizedScope === true,
      clarifyingQuestions: parseClarifyingQuestions(payload.clarifyingQuestions),
      clarifyingResponses: parseClarifyingResponses(payload.clarifyingResponses),
    });

    const totalMs = Date.now() - totalStarted;
    const stage =
      built.route === "combined" ? "combined-analysis-and-prompt" : "task-analysis";

    // One latency line with every field needed to locate a slowdown: LLM time,
    // provider time, parse time and local time are all separated.
    logTiming({
      requestId: built.requestId ?? requestId,
      stage,
      model: built.plan.agentModel ?? aiModel() ?? "unknown",
      totalDurationMs: totalMs,
      llmDurationMs: built.llmDurationMs,
      providerDurationMs: built.providerDurationMs,
      responseParseDurationMs: built.parseDurationMs,
      localCalculationDurationMs: built.localDurationMs,
      success: true,
      retryCount: built.retryCount,
    });

    logStage(requestId, stage, built.llmDurationMs, true, `calls=${built.llmCalls}`);
    if (built.route === "two-call") {
      logStage(requestId, "prompt-generation", 0, true, "included-in-two-call");
    }
    logStage(
      requestId,
      "total",
      totalMs,
      true,
      `calls=${built.llmCalls} local=${built.localDurationMs}ms parse=${built.parseDurationMs}ms`,
    );
    return response.json({ success: true, data: built.plan });
  } catch (error) {
    const ai = toAiError(error, requestId);
    const totalMs = Date.now() - totalStarted;
    logTiming({
      requestId,
      stage: "combined-analysis-and-prompt",
      model: aiModel() ?? "unknown",
      totalDurationMs: totalMs,
      llmDurationMs: 0,
      responseParseDurationMs: 0,
      localCalculationDurationMs: 0,
      success: false,
      retryCount: 0,
      errorCode: ai.code,
    });
    logStage(requestId, "combined-analysis-and-prompt", totalMs, false, `code=${ai.code}`);
    logStage(requestId, "total", totalMs, false, `code=${ai.code}`);

    const status =
      ai.code === "AI_TIMEOUT" ||
      ai.code === "AI_RATE_LIMITED" ||
      ai.code === "AI_PROVIDER_UNREACHABLE"
        ? 503
        : 502;
    const { body } = errorResponse(ai, status);
    console.error(
      `[api] requestId=${ai.requestId} code=${ai.code} status=${ai.status ?? "-"} message=${ai.message}`,
    );
    return response.status(status).json({ ...body, error: { ...body.error, requestId } });
  }
});

app.use((_request, response) => {
  response.status(404).json({
    success: false,
    error: { code: "AI_UNKNOWN_ERROR", message: "Not found", requestId: newRequestId() },
  });
});

app.listen(PORT, () => {
  const health = backendHealth();
  const budgets = tokenBudgets();
  console.log(`Promgent backend listening on port ${PORT}`);
  console.log(`Provider configured: ${health.providerConfigured ? "yes" : "no"}`);
  console.log(`Model: ${health.model ?? "(unset)"}`);
  console.log(
    `Budgets: combined=${aiCombinedMaxTokens()} analysis=${budgets.analysis} ` +
      `prompt=${budgets.prompt} timeoutMs=${health.timeoutMs}`,
  );
  console.log(
    envFilesLoaded.length
      ? `Env files loaded: ${envFilesLoaded.join(", ")}`
      : "Env files loaded: none (using host environment)",
  );
  if (health.missing.length) {
    console.warn(`Missing required env: ${health.missing.join(", ")}`);
  }
  if (usingLegacyEnvNames()) {
    console.warn(
      `Using legacy AI_* variable names. Rename to ${ENV.API_KEY}, ${ENV.BASE_URL}, ${ENV.MODEL}.`,
    );
  }
  if (legacyMaxTokensPresent()) {
    // Ignored on purpose: honouring it would restore one oversized cap for both
    // stages and undo the split budgets that keep calls fast.
    console.warn(
      `AI_MAX_TOKENS is set but ignored. Use ${ENV.MAX_TOKENS} for the combined call, or ${ENV.ANALYSIS_MAX_TOKENS}/${ENV.PROMPT_MAX_TOKENS} for the fallback.`,
    );
  }
  if (isProduction && !allowList) {
    console.warn(
      "ALLOWED_ORIGINS is not set: this API accepts requests from any origin. Set it to your Vercel URL.",
    );
  }
  if (!aiProviderConfigured()) {
    console.warn(
      "Promgent's model is not configured: /api/plan will fail until the AGENTFUND_AI_* variables are set.",
    );
  }
});
