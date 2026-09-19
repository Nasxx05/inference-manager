import type {
  Complexity,
  Confidence,
  EffortLevel,
  PhaseTokens,
  TaskAnalysis,
  TaskEffort,
  TaskPhase,
  TaskRequirementProfile,
  TaskType,
} from "@/types";

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

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "very-high", "extreme"];

export const CONFIDENCES: Confidence[] = ["low", "medium", "high"];

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
 * Normalises the effort block.
 *
 * Returns undefined when the model supplied nothing usable, so the estimator
 * falls back to its own derivation. Never invents an effort score from a label:
 * a wrong-but-precise-looking score would poison the cost estimate, whereas
 * undefined simply means "derive it".
 */
function normalizeEffort(raw: unknown): TaskEffort | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;

  const score = Number(value.effortScore ?? value.score);
  const levelRaw = asString(value.effortLevel ?? value.level).toLowerCase() as EffortLevel;
  const level = EFFORT_LEVELS.includes(levelRaw) ? levelRaw : undefined;

  // Without a numeric score there is nothing trustworthy to use.
  if (!Number.isFinite(score) && !level) return undefined;

  const iterationsRaw = value.estimatedIterations;
  let iterations: TaskEffort["estimatedIterations"] | undefined;
  if (iterationsRaw && typeof iterationsRaw === "object") {
    const it = iterationsRaw as Record<string, unknown>;
    const min = Number(it.min);
    const max = Number(it.max);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      iterations = {
        min: Math.round(clamp(min, 1, 20)),
        max: Math.round(clamp(max, 2, 30)),
      };
    }
  }

  const numeric = (n: unknown, fallback: number) => {
    const parsed = Number(n);
    return Number.isFinite(parsed) ? clamp(Math.round(parsed), 0, 100) : fallback;
  };

  return {
    // A supplied level is a label; when only the score is present, derive it.
    level: level ?? "medium",
    score: Number.isFinite(score) ? clamp(Math.round(score), 0, 100) : 50,
    requirementCount: Math.max(1, Math.round(Number(value.requirementCount) || 1)),
    criticalRequirementCount: Math.max(0, Math.round(Number(value.criticalRequirementCount) || 0)),
    optionalRequirementCount: Math.max(0, Math.round(Number(value.optionalRequirementCount) || 0)),
    estimatedIterations: iterations ?? { min: 2, max: 4 },
    implementationSize: numeric(value.implementationSize, 50),
    contextOverhead: numeric(value.contextOverhead, 40),
    toolOverhead: numeric(value.toolOverhead, 30),
    revisionLoad: numeric(value.revisionLoad, 45),
  };
}

/** Normalises the task requirement profile, or undefined if unusable. */
function normalizeRequirementProfile(raw: unknown): TaskRequirementProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const num = (n: unknown) => {
    const parsed = Number(n);
    return Number.isFinite(parsed) ? clamp(Math.round(parsed), 0, 100) : undefined;
  };

  const coding = num(value.codingRequirement);
  const reasoning = num(value.reasoningRequirement);
  // Need at least the two primary dimensions to be worth using.
  if (coding === undefined && reasoning === undefined) return undefined;

  return {
    codingRequirement: coding ?? reasoning ?? 50,
    reasoningRequirement: reasoning ?? coding ?? 50,
    researchRequirement: num(value.researchRequirement) ?? 40,
    contextRequirement: num(value.contextRequirement) ?? 50,
    structuredOutputRequirement: num(value.structuredOutputRequirement) ?? 50,
  };
}

/** Per-phase token estimates, keyed by phase name. */
function normalizePhaseTokens(raw: unknown): Record<string, PhaseTokens> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const out: Record<string, PhaseTokens> = {};
  let count = 0;

  for (const [name, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const input = Number(e.input ?? e.inputTokens);
    const output = Number(e.output ?? e.outputTokens);
    if (!Number.isFinite(input) && !Number.isFinite(output)) continue;
    out[name] = {
      input: Math.max(200, Math.round(Number.isFinite(input) ? input : 1000)),
      output: Math.max(100, Math.round(Number.isFinite(output) ? output : 500)),
    };
    count += 1;
  }

  return count > 0 ? out : undefined;
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
    // Workload signals. Left undefined when absent so the estimator derives
    // them rather than trusting a placeholder.
    effort: normalizeEffort(value.effort ?? value.taskEffort),
    requirementProfile: normalizeRequirementProfile(
      value.requirementProfile ?? value.taskRequirementProfile,
    ),
    phaseTokens: normalizePhaseTokens(value.phaseTokens),
    confidence: CONFIDENCES.includes(asString(value.confidence).toLowerCase() as Confidence)
      ? (asString(value.confidence).toLowerCase() as Confidence)
      : undefined,
    costDrivers: asStringArray(value.costDrivers).length
      ? asStringArray(value.costDrivers).slice(0, 6)
      : undefined,
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