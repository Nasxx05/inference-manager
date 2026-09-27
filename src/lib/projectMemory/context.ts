import type { ProjectMemory, Requirement } from "@/types/project";
import { structuredAcceptanceCriteria } from "./proposals";

function list(items: string[], empty = "None recorded."): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function requirementLines(requirements: Requirement[]): string {
  return requirements.length
    ? requirements.map((item) => `- [${item.status}] ${item.description} (${item.category}, ${item.priority})`).join("\n")
    : "None recorded.";
}

/** Compact context for an interview turn; never resends the full transcript. */
export function buildProjectContext(memory: ProjectMemory, currentMessage: string): string {
  return [
    "PROJECT MEMORY:",
    `Purpose: ${memory.purpose || "Not yet defined"}`,
    `Project type: ${memory.projectType || "Not yet defined"}`,
    "Requirements:",
    requirementLines(memory.requirements),
    "Open conflicts:",
    list(memory.conflicts.filter((item) => !item.resolved).map((item) => item.description)),
    "Open questions:",
    list(memory.completeness.criticalGaps),
    "Design preferences:",
    list(memory.designPreferences),
    "Acceptance criteria:",
    list(structuredAcceptanceCriteria(memory).map((item) => `[${item.status}] ${item.requirementId}: ${item.description}`)),
    "Current user response:",
    currentMessage.trim(),
  ].join("\n");
}
