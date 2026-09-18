import { NextResponse } from "next/server";
import { AUTO_MODEL_ID, getModel } from "@/data/models";
import { buildPlan } from "@/lib/planner";
import { parseBudget, parseOptimization } from "@/lib/validation/schemas";
import type { OptimizationPreference } from "@/types";

export const runtime = "nodejs";

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

  try {
    const plan = await buildPlan({
      taskDescription,
      modelId,
      optimization,
      budget,
      applyOptimizedScope,
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