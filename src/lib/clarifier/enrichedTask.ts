/**
 * The enriched task: one canonical representation of what the user actually
 * wants, before any LLM analysis.
 *
 * Why this exists: the pipeline previously scattered the user's intent across
 * several places — the raw description here, the answers there, the summary
 * somewhere else — so downstream components could disagree. The prompt could
 * describe the original scope while the UI showed an optimized one.
 *
 * This module produces a single object that every later stage reads from:
 * analyzer, estimator, suitability, scope optimizer and prompt writer. The
 * original wording is always preserved verbatim in `originalTask`; the enriched
 * version is additive, never a replacement.
 */

import type { ClarifyingAnswer, TaskType } from "@/types";

/** How much work a requirement category represents. */
export type RequirementWeight = "low" | "medium" | "high" | "very-high";

export interface ResolvedRequirement {
  /** Short name, e.g. "Authentication". */
  name: string;
  weight: RequirementWeight;
  /** Where it came from: the task text or a specific answer. */
  source: "task" | "answer";
}

export interface EnrichedTask {
  /** The user's request exactly as typed. Never rewritten, never truncated. */
  originalTask: string;
  taskType: TaskType;
  /** Raw answers keyed by question id, for traceability. */
  clarifyingAnswers: Record<string, string>;
  /** Concrete units of work, each with a workload weight. */
  resolvedRequirements: ResolvedRequirement[];
  /** Statements Promgent assumed because a question was skipped. */
  assumptions: string[];
}

/**
 * Requirement categories and their workload weight.
 *
 * This is the mechanism that stops "add a contact section" and "implement Stripe
 * subscriptions" from being treated as equivalent work. Weight reflects real
 * effort — a payment integration carries integration, testing and failure-mode
 * work far beyond a presentational section.
 */
const REQUIREMENT_RULES: { name: string; weight: RequirementWeight; pattern: RegExp }[] = [
  { name: "Authentication", weight: "high", pattern: /\b(auth|authentication|login|sign[- ]?in|sign[- ]?up|oauth|jwt|clerk|session)\b/i },
  { name: "Multi-user or multi-tenancy", weight: "high", pattern: /\b(multi[- ]?user|multi[- ]?tenant|teams?|organi[sz]ations?)\b/i },
  { name: "Payments or billing", weight: "very-high", pattern: /\b(payment|payments|billing|checkout|subscription|stripe|invoice)\b/i },
  { name: "Database and persistence", weight: "high", pattern: /\b(database|postgres|mysql|mongo|sqlite|orm|schema|migration|persist)\b/i },
  { name: "Backend API", weight: "high", pattern: /\b(api|apis|rest|graphql|endpoints?|backend service)\b/i },
  { name: "Admin dashboard", weight: "medium", pattern: /\b(admin|admin dashboard|admin panel)\b/i },
  { name: "Analytics or reporting", weight: "medium", pattern: /\b(analytic|analytics|telemetry|metrics|reporting)\b/i },
  { name: "Vector storage", weight: "high", pattern: /\b(vector (db|database|store)|pinecone|weaviate|qdrant|chroma|pgvector|embedding store)\b/i },
  { name: "Embeddings", weight: "medium", pattern: /\b(embedding|embeddings)\b/i },
  { name: "Document ingestion", weight: "medium", pattern: /\b(ingestion|ingest|document (processing|loading)|chunking)\b/i },
  { name: "Retrieval and reranking", weight: "medium", pattern: /\b(retrieval|retriever|rerank|reranking|hybrid search|semantic search)\b/i },
  { name: "Evaluation", weight: "medium", pattern: /\b(evaluation|eval|benchmark|quality metrics|labelled dataset)\b/i },
  { name: "Deployment and infrastructure", weight: "high", pattern: /\b(deploy|deployment|production[- ]?ready|infrastructure|ci\/cd|docker|kubernetes)\b/i },
  { name: "Notifications or email", weight: "medium", pattern: /\b(email|notification|notifications|sms|webhook)\b/i },
  { name: "Real-time features", weight: "high", pattern: /\b(real[- ]?time|streaming|websocket|live updates)\b/i },
  { name: "Search and filtering", weight: "medium", pattern: /\b(search|full[- ]?text search|filtering|pagination)\b/i },
  { name: "File upload and storage", weight: "medium", pattern: /\b(file upload|upload|storage|s3|blob)\b/i },
  { name: "Caching or rate limiting", weight: "medium", pattern: /\b(rate[- ]?limit|caching|cache|redis)\b/i },
  { name: "Testing", weight: "medium", pattern: /\b(test|tests|testing|unit tests|e2e|integration tests)\b/i },
  { name: "Accessibility", weight: "low", pattern: /\b(accessibility|a11y|wcag)\b/i },
  { name: "Internationalisation", weight: "medium", pattern: /\b(internationali[sz]ation|i18n|locali[sz]ation|multi[- ]?language)\b/i },
  { name: "Mobile support", weight: "high", pattern: /\b(mobile|ios|android|react native|flutter)\b/i },
  { name: "Responsive UI", weight: "low", pattern: /\b(responsive|mobile[- ]?friendly)\b/i },
  { name: "Animations", weight: "low", pattern: /\b(animation|animations|transitions|motion)\b/i },
  { name: "Dark mode", weight: "low", pattern: /\b(dark mode|dark theme|light\/dark)\b/i },
  { name: "Contact form", weight: "low", pattern: /\b(contact form|contact section)\b/i },
];

/** Numeric workload value per weight. */
export const WEIGHT_VALUE: Record<RequirementWeight, number> = {
  low: 1,
  medium: 3,
  high: 6,
  "very-high": 10,
};

/**
 * Builds the enriched task.
 *
 * Requirements are gathered from two places: the task text itself, and the
 * answers to clarifying questions. An answer can confirm a component that was
 * only implied (or absent) in the original wording, which is exactly why asking
 * changes the estimate.
 */
export function buildEnrichedTask(input: {
  taskDescription: string;
  taskType: TaskType;
  answers: ClarifyingAnswer[];
}): EnrichedTask {
  const { taskDescription, taskType, answers } = input;

  const clarifyingAnswers: Record<string, string> = {};
  const assumptions: string[] = [];
  const found = new Map<string, ResolvedRequirement>();

  const record = (requirement: ResolvedRequirement) => {
    // Keep the heavier weight if the same component appears twice.
    const existing = found.get(requirement.name);
    if (existing && WEIGHT_VALUE[existing.weight] >= WEIGHT_VALUE[requirement.weight]) return;
    found.set(requirement.name, requirement);
  };

  for (const rule of REQUIREMENT_RULES) {
    if (rule.pattern.test(taskDescription)) {
      record({ name: rule.name, weight: rule.weight, source: "task" });
    }
  }

  for (const answer of answers) {
    clarifyingAnswers[answer.id] = answer.answer;

    // Skipped answers still describe real work: their default is an assumption
    // Promgent is making on the user's behalf, and it must be stated as such.
    if (!answer.answered) {
      assumptions.push(answer.answer);
    }

    const text = `${answer.question} ${answer.answer}`;
    for (const rule of REQUIREMENT_RULES) {
      if (rule.pattern.test(text)) {
        record({ name: rule.name, weight: rule.weight, source: "answer" });
      }
    }
  }

  return {
    originalTask: taskDescription.trim(),
    taskType,
    clarifyingAnswers,
    resolvedRequirements: [...found.values()],
    assumptions,
  };
}

/**
 * A readable version of the resolved requirements, for the LLM and the UI.
 *
 * The original task is included verbatim and first, so the model always sees the
 * user's own words alongside the resolved structure rather than a paraphrase
 * that could drift from them.
 */
export function describeEnrichedTask(enriched: EnrichedTask): string {
  const lines: string[] = [`ORIGINAL REQUEST: ${enriched.originalTask}`];

  if (enriched.resolvedRequirements.length > 0) {
    lines.push("");
    lines.push("RESOLVED REQUIREMENTS (workload weight):");
    for (const requirement of enriched.resolvedRequirements) {
      lines.push(`- ${requirement.name}: ${requirement.weight}`);
    }
  }

  if (enriched.assumptions.length > 0) {
    lines.push("");
    lines.push("ASSUMED BECAUSE A QUESTION WAS SKIPPED:");
    for (const assumption of enriched.assumptions) {
      lines.push(`- ${assumption}`);
    }
  }

  return lines.join("\n");
}

/** Total weighted workload across all resolved requirements. */
export function requirementWorkload(enriched: EnrichedTask): number {
  return enriched.resolvedRequirements.reduce(
    (sum, requirement) => sum + WEIGHT_VALUE[requirement.weight],
    0,
  );
}

/** The heaviest requirements, for the "major work drivers" panel. */
export function majorWorkDrivers(enriched: EnrichedTask, limit = 6): ResolvedRequirement[] {
  return [...enriched.resolvedRequirements]
    .sort((a, b) => WEIGHT_VALUE[b.weight] - WEIGHT_VALUE[a.weight])
    .slice(0, limit);
}