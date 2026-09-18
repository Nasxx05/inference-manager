import { NextResponse } from "next/server";
import { selectQuestions } from "@/lib/clarifier";
import { analyzeTask } from "@/lib/ai/provider";
import type { TaskType } from "@/types";

export const runtime = "nodejs";

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
 * Returns the clarifying questions for a task before any prompt is compiled.
 * The task type is classified here, or taken from the client if it already
 * ran the analysis step.
 */
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

  let taskType = asTaskType(payload.taskType);

  if (!taskType) {
    try {
      const { analysis } = await analyzeTask(taskDescription);
      taskType = analysis.taskType;
    } catch {
      taskType = "general";
    }
  }

  const questions = selectQuestions(taskDescription, taskType);

  return NextResponse.json({ taskType, questions });
}