import type { Complexity, TaskAnalysis, TaskPhase, TaskType } from "@/types";

export const TASK_TYPES: TaskType[] = [
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

export const COMPLEXITIES: Complexity[] = ["low", "medium", "high", "very-high"];

const PRIORITIES: TaskPhase["priority"][] = ["essential", "recommended", "optional"];

export class AnalysisValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisValidationError";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Never trust raw model output. Normalize and fill gaps from the heuristic
 * baseline so the rest of the pipeline always receives a well-formed analysis.
 */
export function validateAnalysis(raw: unknown, baseline: TaskAnalysis): TaskAnalysis {
  if (!raw || typeof raw !== "object") {
    throw new AnalysisValidationError("Analysis payload is not an object");
  }
  const value = raw as Record<string, unknown>;

  const taskTypeRaw = asString(value.taskType).toLowerCase() as TaskType;
  const taskType = TASK_TYPES.includes(taskTypeRaw) ? taskTypeRaw : baseline.taskType;

  const complexityRaw = asString(value.complexity).toLowerCase() as Complexity;
  const complexity = COMPLEXITIES.includes(complexityRaw) ? complexityRaw : baseline.complexity;

  const summary = asString(value.summary).trim() || baseline.summary;
  if (!summary) {
    throw new AnalysisValidationError("Analysis is missing a summary");
  }

  const phases = normalizePhases(value.phases, baseline.phases);
  if (phases.length === 0) {
    throw new AnalysisValidationError("Analysis is missing phases");
  }

  return {
    taskType,
    summary,
    complexity,
    requiredCapabilities: asStringArray(value.requiredCapabilities).length
      ? asStringArray(value.requiredCapabilities)
      : baseline.requiredCapabilities,
    estimatedInputTokens: Math.round(
      clamp(asNumber(value.estimatedInputTokens, baseline.estimatedInputTokens), 200, 2_000_000),
    ),
    estimatedOutputTokens: Math.round(
      clamp(asNumber(value.estimatedOutputTokens, baseline.estimatedOutputTokens), 100, 1_000_000),
    ),
    expectedIterations: Math.round(
      clamp(asNumber(value.expectedIterations, baseline.expectedIterations), 1, 12),
    ),
    toolRequirements: asStringArray(value.toolRequirements).length
      ? asStringArray(value.toolRequirements)
      : baseline.toolRequirements,
    phases,
    risks: asStringArray(value.risks).length ? asStringArray(value.risks) : baseline.risks,
    scopeAdjustments: asStringArray(value.scopeAdjustments).length
      ? asStringArray(value.scopeAdjustments)
      : baseline.scopeAdjustments,
  };
}

function normalizePhases(raw: unknown, baseline: TaskPhase[]): TaskPhase[] {
  if (!Array.isArray(raw)) return baseline;
  const phases: TaskPhase[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const name = asString(p.name).trim();
    if (!name) continue;
    const priorityRaw = asString(p.priority).toLowerCase() as TaskPhase["priority"];
    phases.push({
      name,
      description: asString(p.description).trim() || name,
      priority: PRIORITIES.includes(priorityRaw) ? priorityRaw : "recommended",
      costWeight: clamp(asNumber(p.costWeight, 1 / Math.max(1, raw.length)), 0.01, 1),
      estimatedCost: [0, 0],
    });
  }
  return phases.length > 0 ? phases : baseline;
}

export interface RequestPayloadShape {
  taskDescription?: unknown;
  modelId?: unknown;
  optimization?: unknown;
  budget?: unknown;
}

export const OPTIMIZATIONS = ["minimize-cost", "balanced", "maximum-quality"] as const;

export function parseBudget(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

export function parseOptimization(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return (OPTIMIZATIONS as readonly string[]).includes(s) ? s : null;
}