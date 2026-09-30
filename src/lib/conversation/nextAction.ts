import type { ConversationIntent, NextRecommendedAction, ProjectPhase } from "@/types/conversation";
import type { ProjectMemory } from "@/types/project";

export function phaseForConversation(memory: ProjectMemory, intents: ConversationIntent[]): ProjectPhase {
  if (intents.includes("repository_review") || intents.includes("live_product_review")) return "reviewing";
  if (memory.currentImplementationState?.trim()) return "building";
  if (memory.completeness.level === "ready") return "ready_to_build";
  return memory.requirements.length > 2 ? "shaping" : "exploring";
}

export function recommendNextAction(memory: ProjectMemory, phase: ProjectPhase): NextRecommendedAction {
  if (phase === "reviewing") return { type: "review_evidence", label: "Review the implementation evidence", reason: "A repository or live implementation is ready to compare with the project plan." };
  if (phase === "building") return { type: "connect_repository", label: "Share the current repository when ready", reason: "Promgent can review the exact implementation commit against the agreed project." };
  if (phase === "ready_to_build") return { type: "generate_prompt", label: "Generate the first implementation prompt", reason: "The project has enough confirmed direction to begin without a formal approval gate." };
  const open = memory.openQuestions.find((item) => !item.resolved);
  return open
    ? { type: "answer_project_question", label: open.question, reason: "This answer materially affects the first version." }
    : { type: "continue_conversation", label: "Describe the most important user workflow", reason: "A concrete workflow will make the build plan more reliable." };
}
