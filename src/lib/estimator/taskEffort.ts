/**
 * Task effort: how much work a request actually represents.
 *
 * This module exists because the old estimator leaned on a complexity label,
 * which collapsed very different workloads together — a one-page site and a
 * full SaaS platform could both read "high" and land on a similar number.
 *
 * There is no complexity-to-credit lookup table anywhere in this file. Effort
 * is derived from observable task characteristics (requirements, phases,
 * implementation size, iterations, context and tool load), and the resulting
 * score feeds the token and iteration estimators.
 *
 * When the analyser supplies its own effort figures they are preferred; the
 * derivation here fills gaps and provides a sane baseline when a model omits
 * them. Every value is clamped so a malformed payload cannot produce absurd
 * costs.
 */

import type { EffortLevel, TaskAnalysis, TaskEffort, TaskType } from "@/types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function effortLevelFromScore(score: number): EffortLevel {
  if (score < 20) return "low";
  if (score < 40) return "medium";
  if (score < 62) return "high";
  if (score < 82) return "very-high";
  return "extreme";
}

/** Task types that produce a large buildable artifact. */
const IMPLEMENTATION_HEAVY: TaskType[] = ["coding", "web-development"];
/** Task types dominated by reading and synthesis rather than building. */
const CONTEXT_HEAVY: TaskType[] = ["research", "document-analysis", "data-analysis"];

/**
 * Estimates how many distinct requirements the request contains.
 *
 * A "complete SaaS platform" is not one task, it is a collection of
 * substantial subsystems. Counting them is what stops a multi-feature system
 * from being priced like a landing page.
 *
 * This is a heuristic for when the analyser omits the count: it looks for
 * enumerations, commas and known subsystem keywords.
 */
const SUBSYSTEM_KEYWORDS = [
  "auth", "authentication", "login", "signup", "sign-up", "database", "db",
  "api", "backend", "frontend", "dashboard", "admin", "payments", "payment",
  "billing", "subscription", "analytics", "notification", "email", "search",
  "upload", "storage", "cache", "queue", "deployment", "deploy", "ci", "cd",
  "testing", "test", "monitoring", "logging", "vector", "embedding",
  "retrieval", "ingestion", "chunking", "evaluation", "multi-tenant",
  "webhook", "integration", "migration", "security", "rate-limit",
];

export function estimateRequirementCount(taskDescription: string): number {
  const text = (taskDescription ?? "").toLowerCase();
  if (!text.trim()) return 1;

  const keywordHits = new Set<string>();
  for (const keyword of SUBSYSTEM_KEYWORDS) {
    // Word-ish match so "test" does not fire on "latest".
    if (new RegExp(`\\b${keyword}\\w*`).test(text)) keywordHits.add(keyword);
  }

  // Explicit enumerations ("a, b and c") are strong evidence of a real list.
  const listMatches = text.match(/\b\w+(?:\s*,\s*\b\w+\b)*(?:\s+and\s+\b\w+\b)?/g) ?? [];
  const commaRuns = listMatches.filter((m) => m.includes(",")).length;

  const counted = Math.max(keywordHits.size, commaRuns > 0 ? commaRuns + 1 : 0);
  // At least one requirement; generous cap so a rambling prompt cannot explode.
  return clamp(counted || 1, 1, 30);
}

/**
 * Weights phases by effort rather than counting them.
 *
 * Counting alone is misleading: "requirements, implementation" and a
 * fifteen-phase RAG pipeline are not comparable. Weight comes from the phase's
 * declared costWeight plus a keyword bump for phases known to be expensive
 * (embeddings, vector storage, payments, deployment).
 */
const HEAVY_PHASE_KEYWORDS = [
  "implementation", "build", "develop", "code", "integration", "embedding",
  "vector", "retrieval", "ingestion", "chunking", "payment", "deployment",
  "migration", "evaluation", "optimization", "testing", "architecture",
];

function phaseEffortWeight(name: string, declared: number): number {
  const lower = name.toLowerCase();
  const heavy = HEAVY_PHASE_KEYWORDS.some((k) => lower.includes(k)) ? 1.25 : 1;
  return Math.max(0.05, declared) * heavy;
}

export interface EffortInput {
  analysis: TaskAnalysis;
  taskDescription: string;
}

/**
 * Derives the effort model, preferring analyser-supplied values.
 *
 * The score blends five independent signals. They are weighted so that a task
 * which is large in one dimension (say, huge context but tiny implementation)
 * does not get priced as if it were large in all of them.
 */
export function deriveTaskEffort({ analysis, taskDescription }: EffortInput): TaskEffort {
  const phases = analysis.phases ?? [];
  const complexity = analysis.complexity ?? "medium";

  const requirementCount = estimateRequirementCount(taskDescription);
  // Most named requirements in a real brief are load-bearing; a flat split
  // would understate critical work in a large system.
  const criticalRequirementCount = Math.max(1, Math.round(requirementCount * 0.7));
  const optionalRequirementCount = Math.max(0, requirementCount - criticalRequirementCount);

  const phaseLoad = phases.reduce(
    (sum, phase) => sum + phaseEffortWeight(phase.name, phase.costWeight ?? 0),
    0,
  );

  const complexityScore = { low: 12, medium: 32, high: 55, "very-high": 78 }[complexity] ?? 32;
  const requirementScore = clamp(requirementCount * 6, 0, 100);

  /**
   * Phase load, normalised so a generic baseline cannot saturate the score.
   *
   * The heuristic analyser returns a fixed short phase list with uniform
   * weights, so summing raw weights gives every task the same large number and
   * washes out every other signal. Dividing by the phase count measures the
   * *average* heft per phase; the count then contributes separately and
   * sub-linearly, which is what makes a 12-phase plan cost more than a 3-phase
   * one without dominating the result.
   */
  const avgPhaseWeight = phases.length > 0 ? phaseLoad / phases.length : 0;
  const phaseCountScore = clamp(Math.log2(1 + phases.length) * 22, 0, 100);
  const phaseScore = clamp(avgPhaseWeight * 70 + phaseCountScore * 0.3, 0, 100);

  const isImplementationHeavy = IMPLEMENTATION_HEAVY.includes(analysis.taskType);
  const isContextHeavy = CONTEXT_HEAVY.includes(analysis.taskType);

  /**
   * Signal from the description itself.
   *
   * The heuristic analyser returns a coarse baseline (it cannot see how much
   * work a sentence implies), so without this a one-line task and a
   * multi-clause brief score identically. Word count and clause count are the
   * cheapest honest proxies for "how much did the user actually ask for".
   */
  const words = taskDescription.trim().split(/\s+/).filter(Boolean);
  // Plain "and"/comma enumeration, e.g. "auth, database, API and payments".
  const clauses = taskDescription.split(/[,;]|\band\b/i).filter((c) => c.trim().length > 2).length;
  const describedWork = clamp((words.length / 50) * 50 + (clauses - 1) * 9, 0, 100);

  /**
   * Artifact signal: does the task BUILD something, or only produce prose?
   *
   * "Write a product description" and "Build a responsive portfolio website"
   * are both short and single-requirement, yet the second involves real
   * implementation. A build verb combined with an implementation-heavy type is
   * what separates them without hard-coding either task.
   */
  const buildVerb = /\b(build|create|develop|implement|design|generate|make|architect|ship)\b/i.test(
    taskDescription,
  )
    ? 1
    : 0;
  const artifactFactor = isImplementationHeavy ? (buildVerb ? 1 : 0.7) : buildVerb ? 0.6 : 0.35;

  // Implementation and context scale off the primary signals above, then get a
  // task-type nudge. A research task is context-heavy but barely implements.
  const implementationSize = clamp(
    (requirementScore * 0.35 + phaseScore * 0.3 + complexityScore * 0.15 + describedWork * 0.2) *
      (isImplementationHeavy ? 1.15 : isContextHeavy ? 0.5 : 0.85) *
      (0.55 + artifactFactor * 0.65),
    0,
    100,
  );

  const contextOverhead = clamp(
    (isContextHeavy ? 45 : 22) + complexityScore * 0.2 + describedWork * 0.25,
    0,
    100,
  );

  const toolCount = (analysis.toolRequirements ?? []).length;
  const toolOverhead = clamp(
    toolCount * 14 + (isImplementationHeavy ? 8 : 0) + describedWork * 0.12,
    0,
    100,
  );

  // Debugging and revision grow super-linearly with size: a big system does not
  // just have more code, it has more integration seams where things break.
  const revisionLoad = clamp(
    implementationSize * 0.6 + complexityScore * 0.3 + (toolCount > 2 ? 10 : 0),
    0,
    100,
  );

  const score = Math.round(
    clamp(
        complexityScore * 0.14 +
        requirementScore * 0.18 +
        phaseScore * 0.16 +
        describedWork * 0.16 +
        implementationSize * 0.18 +
        revisionLoad * 0.12 +
        contextOverhead * 0.06,
      0,
      100,
    ),
  );

  const iterations = deriveIterations({
    implementationSize,
    revisionLoad,
    complexity,
    phases: phases.length,
    effortScore: score,
  });

  return {
    level: effortLevelFromScore(score),
    score,
    requirementCount,
    criticalRequirementCount,
    optionalRequirementCount,
    estimatedIterations: iterations,
    implementationSize: Math.round(implementationSize),
    contextOverhead: Math.round(contextOverhead),
    toolOverhead: Math.round(toolOverhead),
    revisionLoad: Math.round(revisionLoad),
  };
}

/**
 * Expected iteration range.
 *
 * Planning ranges, not universal truths: they scale with implementation size
 * and revision load, so a simple task stays at 1-2 while a large system lands
 * in the 6-12 band the brief describes.
 */
export function deriveIterations(input: {
  implementationSize: number;
  revisionLoad: number;
  complexity: TaskAnalysis["complexity"];
  phases: number;
  /** Overall effort, so a trivially small task stays at 1-2 passes. */
  effortScore: number;
}): { min: number; max: number } {
  const { implementationSize, revisionLoad, complexity, phases, effortScore } = input;
  const sizeFactor = implementationSize / 100;
  const revisionFactor = revisionLoad / 100;
  const effortFactor = clamp(effortScore, 0, 100) / 100;

  // Driven mostly by overall effort: a small task must not land at 7 passes
  // just because the baseline supplied a generic phase list.
  let min = 1 + Math.round(effortFactor * 4 + revisionFactor * 1.5);
  let max = 2 + Math.round(effortFactor * 6 + revisionFactor * 2.5 + sizeFactor * 1.5 + phases * 0.1);

  if (complexity === "very-high") {
    min += 1;
    max += 2;
  }

  return { min: clamp(min, 1, 12), max: clamp(Math.max(max, min + 1), 2, 20) };
}

/**
 * Merges analyser-supplied effort with the derived baseline.
 *
 * Any field the model omitted falls back to the derivation; supplied numbers
 * are clamped so a hallucinated value cannot produce an absurd estimate.
 */
export function resolveTaskEffort(input: EffortInput): TaskEffort {
  const derived = deriveTaskEffort(input);
  const supplied = input.analysis.effort;
  if (!supplied) return derived;

  const clamp01to100 = (n: unknown, fallback: number) =>
    typeof n === "number" && Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : fallback;

  const iterations = supplied.estimatedIterations;
  const validIterations =
    iterations &&
    typeof iterations.min === "number" &&
    typeof iterations.max === "number" &&
    Number.isFinite(iterations.min) &&
    Number.isFinite(iterations.max);

  const score = clamp01to100(supplied.score, derived.score);

  return {
    level: effortLevelFromScore(score),
    score,
    requirementCount: clamp(
      Math.round(Number(supplied.requirementCount) || derived.requirementCount),
      1,
      60,
    ),
    criticalRequirementCount: clamp(
      Math.round(Number(supplied.criticalRequirementCount) || derived.criticalRequirementCount),
      0,
      60,
    ),
    optionalRequirementCount: clamp(
      Math.round(Number(supplied.optionalRequirementCount) || derived.optionalRequirementCount),
      0,
      60,
    ),
    estimatedIterations: validIterations
      ? {
          min: clamp(Math.round(iterations.min), 1, 20),
          max: clamp(Math.round(iterations.max), 2, 30),
        }
      : derived.estimatedIterations,
    implementationSize: clamp01to100(supplied.implementationSize, derived.implementationSize),
    contextOverhead: clamp01to100(supplied.contextOverhead, derived.contextOverhead),
    toolOverhead: clamp01to100(supplied.toolOverhead, derived.toolOverhead),
    revisionLoad: clamp01to100(supplied.revisionLoad, derived.revisionLoad),
  };
}