import type { ConversationIntent } from "@/types/conversation";
import type { InterviewMessage, ProjectMemory } from "@/types/project";
import { normalizeProjectMemory } from "@/lib/projectMemory/compatibility";
import { structuredAcceptanceCriteria } from "@/lib/projectMemory/proposals";

const MAX_CONTEXT_CHARS = 18_000;

function lines(label: string, values: string[], limit: number): string {
  return `${label}:\n${values.length ? values.slice(0, limit).map((value) => `- ${value}`).join("\n") : "- None recorded"}`;
}

function relevantRequirement(memory: ProjectMemory, message: string) {
  const terms = new Set(message.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4));
  return [...memory.requirements]
    .filter((item) => item.status !== "rejected" && item.status !== "superseded")
    .sort((a, b) => {
      const score = (value: string) => [...terms].filter((term) => value.toLowerCase().includes(term)).length + (value === "confirmed" ? 2 : 0);
      return score(b.description) - score(a.description) || Number(b.required) - Number(a.required);
    })
    .slice(0, 28);
}

/** Compose relevant canonical state plus a small recent-history window. */
export function composeConversationContext(input: {
  memory: ProjectMemory;
  intents: ConversationIntent[];
  currentMessage: string;
  recentMessages?: InterviewMessage[];
}): string {
  const memory = normalizeProjectMemory(input.memory);
  const requirements = relevantRequirement(memory, input.currentMessage);
  const included = new Set(requirements.map((item) => item.id));
  const sections = [
    "CANONICAL PROJECT MEMORY (trusted application state):",
    `Purpose: ${memory.purpose || "Not yet defined"}`,
    `Project type: ${memory.projectType || "Not yet defined"}`,
    `Phase: ${memory.projectPhase ?? "exploring"}`,
    `Detected intents: ${input.intents.join(", ")}`,
    lines("Primary users", memory.users, 12),
    lines("MVP scope", memory.mvpScope ?? [], 20),
    lines("Deferred scope", memory.deferredScope ?? [], 12),
    lines("Confirmed technical choices", memory.confirmedStack ?? [], 12),
    lines("Constraints", [...(memory.constraints ?? []), ...memory.technicalConstraints], 16),
    lines("Requirements", requirements.map((item) => `[${item.status}/${item.priority}] ${item.id}: ${item.description}`), 28),
    lines("Acceptance criteria", structuredAcceptanceCriteria(memory).filter((item) => included.has(item.requirementId)).map((item) => `[${item.status}] ${item.requirementId}: ${item.description}`), 28),
    lines("Known problems", memory.knownProblems ?? [], 12),
    lines("Decisions", (memory.decisions ?? []).filter((item) => item.status === "confirmed" || item.status === "proposed").map((item) => `[${item.status}] ${item.decision}: ${item.reason}`), 12),
    `Architecture summary: ${memory.architectureSummary || "Not yet established"}`,
    lines("Open decisions", memory.openQuestions.filter((item) => !item.resolved).sort((a, b) => b.importance - a.importance).map((item) => item.question), 8),
  ];
  const recent = (input.recentMessages ?? [])
    .filter((item) => item.role === "user")
    .slice(-3)
    .map((item) => `USER: ${item.content.slice(0, 1200)}`);
  if (recent.length) sections.push("RECENT USER INPUT (historical evidence; do not repeat your earlier answer):", ...recent);
  sections.push("CURRENT USER MESSAGE:", input.currentMessage.trim());
  return sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

export const conversationContextLimit = MAX_CONTEXT_CHARS;
