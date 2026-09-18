import { NextResponse } from "next/server";
import { AUTO_MODEL_ID, getModel } from "@/data/models";
import { PromptGenerationError } from "@/lib/ai/promptGenerator";
import { buildPlan } from "@/lib/planner";
import { parseBudget, parseOptimization } from "@/lib/validation/schemas";
import type { ClarifyingQuestion, OptimizationPreference } from "@/types";

export const runtime = "nodejs";

const MAX_QUESTIONS = 12;
const MAX_ANSWER_LENGTH = 2000;

/**
 * Maps an internal failure to something the user can act on. Raw provider
 * text is never forwarded.
 */
function userFacingPromptError(error: unknown): string {
  if (!(error instanceof PromptGenerationError)) {
    return "We couldn't write your prompt just now. The prompt model didn't respond in time — please try again.";
  }

  // Status-specific causes first. These are the conditions a server operator
  // can actually act on, so they must not collapse into a generic message.
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
    return "The prompt model rejected the credentials, so nothing was written. Check AI_API_KEY on the server.";
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

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;

  const taskDescription = String(payload.taskDescription ?? "").trim();
  if (!taskDescription) {
    return NextResponse.json(
      { error: "Describe what you want to accomplish before continuing." },
      { status: 400 },
    );
  }
  if (taskDescription.length > 8000) {
    return NextResponse.json({ error: "Task description is too long." }, { status: 400 });
  }

  const budget = parseBudget(payload.budget);
  if (budget === null) {
    return NextResponse.json(
      { error: "Enter a valid CREDIT amount greater than zero." },
      { status: 400 },
    );
  }

  const optimization = parseOptimization(payload.optimization) as OptimizationPreference | null;
  if (!optimization) {
    return NextResponse.json({ error: "Select an optimization preference." }, { status: 400 });
  }

  const modelId = String(payload.modelId ?? "").trim() || AUTO_MODEL_ID;
  if (modelId !== AUTO_MODEL_ID && !getModel(modelId)) {
    return NextResponse.json({ error: "Select a valid target model." }, { status: 400 });
  }

  const applyOptimizedScope = payload.applyOptimizedScope === true;

  const clarifyingQuestions = parseClarifyingQuestions(payload.clarifyingQuestions);
  const clarifyingResponses = parseClarifyingResponses(payload.clarifyingResponses);

  try {
    const plan = await buildPlan({
      taskDescription,
      modelId,
      optimization,
      budget,
      applyOptimizedScope,
      clarifyingQuestions,
      clarifyingResponses,
    });
    return NextResponse.json({ plan });
  } catch (error) {
    // Never surface raw provider errors to the client. The prompt is always
    // model-written, so a failure here means there is no prompt to return.
    return NextResponse.json({ error: userFacingPromptError(error) }, { status: 502 });
  }
}
