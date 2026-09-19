/**
 * AgentFund backend.
 *
 * This service owns the LLM credentials and does the slow work: task analysis
 * and prompt generation. The Next.js frontend on Vercel holds no credentials
 * and never calls the model provider; the browser calls this service directly.
 *
 * The provider layer is model-agnostic: nothing here knows which model is in
 * use. Configure on Render:
 *
 *   AGENTFUND_AI_BASE_URL, AGENTFUND_AI_API_KEY, AGENTFUND_AI_MODEL
 *   (optional: AGENTFUND_AI_MAX_TOKENS, AGENTFUND_AI_TIMEOUT_MS,
 *              AGENTFUND_AI_FALLBACK_MODEL, ALLOWED_ORIGINS)
 *
 * Changing AGENTFUND_AI_MODEL is enough to switch the internal model.
 */

import cors from "cors";
import express from "express";
import { loadLocalEnv } from "./loadEnv";
import { AiError, newRequestId, toAiError } from "@/lib/ai/errors";
import { ENV, aiModel, usingLegacyEnvNames } from "@/lib/ai/env";
import { aiHealth, backendHealth, simpleAiTest } from "@/lib/ai/health";
import { analyzeTask } from "@/lib/ai/provider";
import { aiProviderConfigured } from "@/lib/ai/env";
import { buildPlan } from "@/lib/planner";
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
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Render pings this to decide whether the instance is healthy. It must never
 * depend on the provider being reachable, or a provider outage would cause
 * Render to kill a perfectly good instance.
 */
app.get("/health", (_request, response) => {
  response.json({ success: true, data: backendHealth() });
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
      return "The AgentFund backend is not configured with a model. Set AGENTFUND_AI_API_KEY, AGENTFUND_AI_BASE_URL and AGENTFUND_AI_MODEL, then restart.";
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
      return "The AI provider returned a response AgentFund could not use. Please try again.";
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

/** Returns the clarifying questions for a task before any prompt is written. */
app.post("/api/clarify", async (request, response) => {
  const payload = (request.body ?? {}) as Record<string, unknown>;

  const taskDescription = String(payload.taskDescription ?? "").trim();
  if (!taskDescription) {
    return response.status(400).json({
      success: false,
      error: {
        code: "AI_VALIDATION_FAILED",
        message: "Describe what you want to accomplish before continuing.",
        requestId: newRequestId(),
      },
    });
  }
  if (taskDescription.length > MAX_TASK_LENGTH) {
    return response.status(400).json({
      success: false,
      error: {
        code: "AI_VALIDATION_FAILED",
        message: "Task description is too long.",
        requestId: newRequestId(),
      },
    });
  }

  let taskType = asTaskType(payload.taskType);

  if (!taskType) {
    try {
      const { analysis } = await analyzeTask(taskDescription);
      taskType = analysis.taskType;
    } catch (error) {
      const ai = toAiError(error);
      // Questions are task-specific, so a failed analysis cannot produce a
      // meaningful set. Report the real cause instead of guessing a type.
      return response.status(502).json(errorResponse(ai, 502).body);
    }
  }

  return response.json({
    success: true,
    data: { taskType, questions: selectQuestions(taskDescription, taskType) },
  });
});

/** Builds the full plan, including the model-written prompt. */
app.post("/api/plan", async (request, response) => {
  const payload = (request.body ?? {}) as Record<string, unknown>;

  const input = validatePlanInput(payload);
  if (!input.ok) {
    return response.status(400).json({
      success: false,
      error: { code: "AI_VALIDATION_FAILED", message: input.message, requestId: newRequestId() },
    });
  }

  try {
    const plan = await buildPlan({
      taskDescription: input.taskDescription,
      modelId: String(payload.modelId ?? "").trim() || "auto",
      optimization: input.optimization,
      budget: input.budget,
      applyOptimizedScope: payload.applyOptimizedScope === true,
      clarifyingQuestions: parseClarifyingQuestions(payload.clarifyingQuestions),
      clarifyingResponses: parseClarifyingResponses(payload.clarifyingResponses),
    });
    return response.json({ success: true, data: plan });
  } catch (error) {
    const ai = toAiError(error);
    // 503 for conditions that may clear; 502 for everything else. Raw provider
    // text is never forwarded, and the requestId ties this to the server log.
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
    return response.status(status).json(body);
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
  console.log(`AgentFund backend listening on port ${PORT}`);
  console.log(`Provider configured: ${health.providerConfigured ? "yes" : "no"}`);
  console.log(`Model: ${health.model ?? "(unset)"}`);
  console.log(`maxTokens=${health.maxTokens} timeoutMs=${health.timeoutMs}`);
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
  if (isProduction && !allowList) {
    console.warn(
      "ALLOWED_ORIGINS is not set: this API accepts requests from any origin. Set it to your Vercel URL.",
    );
  }
  if (!aiProviderConfigured()) {
    console.warn(
      "AgentFund's model is not configured: /api/plan will fail until the AGENTFUND_AI_* variables are set.",
    );
  }
});