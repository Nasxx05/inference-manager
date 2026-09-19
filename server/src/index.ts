/**
 * AgentFund backend.
 *
 * This service owns the LLM credentials and does the slow work: task analysis
 * and prompt generation. The Next.js frontend on Vercel holds no credentials
 * and never calls the model provider; the browser calls this service directly.
 *
 * Configure on Render: AI_BASE_URL, AI_API_KEY, AI_MODEL (plus optional
 * AI_MAX_TOKENS, AI_TIMEOUT_MS and ALLOWED_ORIGINS).
 */

import cors from "cors";
import express from "express";
import { loadLocalEnv } from "./loadEnv";
import { selectQuestions } from "@/lib/clarifier";
import { analyzeTask } from "@/lib/ai/provider";
import { PromptGenerationError } from "@/lib/ai/promptGenerator";
import { aiApiKey, aiBaseUrl, aiModel, aiProviderConfigured } from "@/lib/ai/env";
import { buildPlan } from "@/lib/planner";
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

/**
 * Origins allowed to call this API from a browser. Comma separated.
 * Defaults to open, so local development works without extra setup.
 */
function allowedOrigins(): string[] | null {
  const raw = (process.env.ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

const allowList = allowedOrigins();

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin or server-to-server calls have no Origin header.
      if (!origin) return callback(null, true);
      if (!allowList) return callback(null, true);
      return callback(null, allowList.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(express.json({ limit: "1mb" }));

/**
 * Render pings this to decide whether the instance is healthy. It must not
 * depend on the provider being reachable, or a provider outage would cause
 * Render to kill a perfectly good instance.
 */
app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    providerConfigured: aiProviderConfigured(),
    // Presence only, never the value. A key that is set but empty on the host
    // reads as "configured: false" here, which is the most common cause of a
    // 401 that looks like a bad key.
    apiKeyPresent: Boolean(aiApiKey()),
    baseUrlPresent: Boolean(aiBaseUrl()),
    model: aiModel(),
  });
});

/**
 * Maps an internal failure to something the user can act on. Raw provider
 * text is never forwarded.
 */
function userFacingPromptError(error: unknown): string {
  if (!(error instanceof PromptGenerationError)) {
    return "We couldn't write your prompt just now. The prompt model didn't respond in time — please try again.";
  }

  if (error.status === 402) {
    return "The prompt model's account has run out of credit, so nothing was written. Top up the server AI account.";
  }
  if (error.status === 429) {
    return "The prompt model is rate limited right now, so nothing was written. Wait a moment and try again.";
  }
  if (error.status === 408 || error.status === 409) {
    return "The prompt model was busy and did not accept the request. Please try again.";
  }
  if (error.status === 401 || error.status === 403) {
    // A blank key fails preflight with the same status as a real rejection, but
    // the fix is different, so keep the two messages distinct.
    if (error.message.includes("No prompt-model API key")) {
      return "No AI_API_KEY is set on the server, so nothing was written. Set it and restart the backend.";
    }
    return "The prompt model rejected the credentials, so nothing was written. Check that AI_API_KEY on the server is correct and complete (no trailing spaces or newline).";
  }
  if (error.status !== undefined && !error.retryable) {
    return "The prompt model rejected the request, so nothing was written. Check the server AI configuration.";
  }
  if (error.message.includes("token budget")) {
    return "The prompt model spent its whole budget thinking and returned nothing. Try a shorter task description, or try again.";
  }
  if (error.message.includes("unusable structure")) {
    return "The prompt model returned something we couldn't use. Please try again.";
  }
  return "We couldn't write your prompt just now. The prompt model didn't respond in time — please try again.";
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

/** Returns the clarifying questions for a task before any prompt is written. */
app.post("/api/clarify", async (request, response) => {
  const payload = (request.body ?? {}) as Record<string, unknown>;

  const taskDescription = String(payload.taskDescription ?? "").trim();
  if (!taskDescription) {
    return response
      .status(400)
      .json({ error: "Describe what you want to accomplish before continuing." });
  }
  if (taskDescription.length > 8000) {
    return response.status(400).json({ error: "Task description is too long." });
  }

  let taskType = asTaskType(payload.taskType);

  if (!taskType) {
    try {
      const { analysis } = await analyzeTask(taskDescription);
      taskType = analysis.taskType;
    } catch {
      taskType = "general";
    }
  }

  return response.json({ taskType, questions: selectQuestions(taskDescription, taskType) });
});

/** Builds the full plan, including the model-written prompt. */
app.post("/api/plan", async (request, response) => {
  const payload = (request.body ?? {}) as Record<string, unknown>;

  const taskDescription = String(payload.taskDescription ?? "").trim();
  if (!taskDescription) {
    return response
      .status(400)
      .json({ error: "Describe what you want to accomplish before continuing." });
  }
  if (taskDescription.length > 8000) {
    return response.status(400).json({ error: "Task description is too long." });
  }

  const budget = parseBudget(payload.budget);
  if (budget === null) {
    return response.status(400).json({ error: "Enter a valid CREDIT amount greater than zero." });
  }

  const optimization = parseOptimization(payload.optimization) as OptimizationPreference | null;
  if (!optimization) {
    return response.status(400).json({ error: "Select an optimization preference." });
  }

  const modelId = String(payload.modelId ?? "").trim();

  try {
    const plan = await buildPlan({
      taskDescription,
      modelId: modelId || "auto",
      optimization,
      budget,
      applyOptimizedScope: payload.applyOptimizedScope === true,
      clarifyingQuestions: parseClarifyingQuestions(payload.clarifyingQuestions),
      clarifyingResponses: parseClarifyingResponses(payload.clarifyingResponses),
    });
    return response.json({ plan });
  } catch (error) {
    // Never surface raw provider errors. The prompt is always model-written,
    // so a failure here means there is no prompt to return.
    return response.status(502).json({ error: userFacingPromptError(error) });
  }
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`AgentFund backend listening on port ${PORT}`);
  console.log(`Provider configured: ${aiProviderConfigured() ? "yes" : "no"}`);
  console.log(`API key present: ${aiApiKey() ? "yes" : "no"}`);
  console.log(`Model: ${aiModel()}`);
  // Says where configuration came from. Empty on the host, where the variables
  // are already set, which makes it clear a local file is not in play.
  console.log(
    envFilesLoaded.length
      ? `Env files loaded: ${envFilesLoaded.join(", ")}`
      : "Env files loaded: none (using host environment)",
  );
});
