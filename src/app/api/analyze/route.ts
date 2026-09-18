import { NextResponse } from "next/server";
import { AUTO_MODEL_ID, getModel } from "@/data/models";
import { buildPlan } from "@/lib/planner";
import { parseBudget, parseOptimization } from "@/lib/validation/schemas";
import type { ClarifyingQuestion, OptimizationPreference } from "@/types";

export const runtime = "nodejs";

const MAX_QUESTIONS = 12;
const MAX_ANSWER_LENGTH = 2000;

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
    out.push({ id, question, defaultValue });
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
  } catch {
    // Never surface raw provider errors to the client.
    return NextResponse.json(
      { error: "We couldn't analyze this task. Please try again." },
      { status: 500 },
    );
  }
}