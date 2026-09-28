import type { ProjectMemory, Requirement } from "@/types/project";
import { structuredAcceptanceCriteria } from "./proposals";

function list(items: string[], empty = "None recorded."): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

const CONTEXT_LIMITS = {
  confirmedRequirements: 32,
  proposedRequirements: 12,
  conflicts: 10,
  questions: 12,
  acceptanceCriteria: 32,
  preferences: 12,
} as const;

const priorityRank: Record<Requirement["priority"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

function prioritizedRequirements(requirements: Requirement[]): Requirement[] {
  const active = requirements.filter((item) => item.status !== "rejected" && item.status !== "superseded");
  const ordered = [...active].sort((left, right) =>
    priorityRank[left.priority] - priorityRank[right.priority]
    || Number(right.required) - Number(left.required)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
  const confirmed = ordered.filter((item) => item.status === "confirmed").slice(0, CONTEXT_LIMITS.confirmedRequirements);
  const proposed = ordered.filter((item) => item.status !== "confirmed").slice(0, CONTEXT_LIMITS.proposedRequirements);
  return [...confirmed, ...proposed];
}

function requirementLines(requirements: Requirement[]): string {
  return requirements.length
    ? requirements.map((item) => `- [${item.status}] ${item.description} (${item.category}, ${item.priority})`).join("\n")
    : "None recorded.";
}

/** Compact context for an interview turn; never resends the full transcript. */
export function buildProjectContext(memory: ProjectMemory, currentMessage: string): string {
  const requirements = prioritizedRequirements(memory.requirements);
  const includedRequirementIds = new Set(requirements.map((item) => item.id));
  const questions = [...memory.openQuestions]
    .filter((item) => !item.resolved)
    .sort((left, right) => right.importance - left.importance || right.informationGain - left.informationGain || left.id.localeCompare(right.id))
    .slice(0, CONTEXT_LIMITS.questions)
    .map((item) => `${item.area}: ${item.question}`);
  return [
    "PROJECT MEMORY:",
    `Purpose: ${memory.purpose || "Not yet defined"}`,
    `Project type: ${memory.projectType || "Not yet defined"}`,
    "Requirements:",
    requirementLines(requirements),
    "Open conflicts:",
    list(memory.conflicts.filter((item) => !item.resolved).slice(0, CONTEXT_LIMITS.conflicts).map((item) => item.description)),
    "Open questions:",
    list(questions.length ? questions : memory.completeness.criticalGaps.slice(0, CONTEXT_LIMITS.questions)),
    "Design preferences:",
    list(memory.designPreferences.slice(0, CONTEXT_LIMITS.preferences)),
    "Acceptance criteria:",
    list(structuredAcceptanceCriteria(memory)
      .filter((item) => includedRequirementIds.has(item.requirementId))
      .sort((left, right) => Number(right.status === "confirmed") - Number(left.status === "confirmed") || left.id.localeCompare(right.id))
      .slice(0, CONTEXT_LIMITS.acceptanceCriteria)
      .map((item) => `[${item.status}] ${item.requirementId}: ${item.description}`)),
    "Current user response:",
    currentMessage.trim(),
  ].join("\n");
}

export const __contextLimits = CONTEXT_LIMITS;
