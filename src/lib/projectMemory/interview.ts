import type { InterviewMessage, InterviewSession, ProjectMemory } from "@/types/project";
import { nextBestQuestion, refreshQuestionBacklog } from "./backlog";
import { calculateCompleteness } from "./completeness";
import { detectContradictions } from "./contradictions";
import { createRequirement } from "./requirements";

export interface InterviewTurnResult {
  memory: ProjectMemory;
  session: InterviewSession;
  userMessage: InterviewMessage;
  assistantMessage: InterviewMessage;
}

/**
 * Deterministic local interview update used until the model-backed structured
 * proposal adapter is invoked. It keeps the data contract honest: the user's
 * own answer is confirmed, while anything merely inferred remains proposed.
 */
export function applyInterviewTurn(input: {
  memory: ProjectMemory;
  session: InterviewSession;
  content: string;
  source?: InterviewMessage["source"];
  assistantContent?: string;
  now?: string;
}): InterviewTurnResult {
  const now = input.now ?? new Date().toISOString();
  const content = input.content.trim();
  const userMessage: InterviewMessage = {
    id: `message_${Date.now().toString(36)}_user`,
    projectId: input.memory.projectId,
    sessionId: input.session.id,
    role: "user",
    content,
    source: input.source ?? "text",
    createdAt: now,
  };

  const candidate = createRequirement({
    projectId: input.memory.projectId,
    description: content,
    category: "core_functionality",
    priority: "medium",
    required: true,
    source: "user",
    sourceMessageId: userMessage.id,
    status: "confirmed",
    confidence: "high",
    now,
  });
  const requirements = input.memory.requirements.some((item) => item.id === candidate.id)
    ? input.memory.requirements
    : [...input.memory.requirements, candidate];
  const draft: Omit<ProjectMemory, "completeness"> = {
    ...input.memory,
    requirements,
    version: input.memory.version + 1,
    updatedAt: now,
  };
  const conflicts = detectContradictions({ ...draft, completeness: input.memory.completeness });
  const withConflicts = { ...draft, conflicts };
  const memory: ProjectMemory = {
    ...withConflicts,
    openQuestions: refreshQuestionBacklog(withConflicts),
    completeness: calculateCompleteness(withConflicts, input.session.planningDepth),
  };
  const next = nextBestQuestion(memory);
  const generatedAssistantContent = next
    ? `Thanks — I’ve added that to the project understanding. ${next.question}`
    : memory.completeness.level === "ready"
      ? "Thanks — I have enough information to prepare the project specification. You can review it now or continue refining the details."
      : "Thanks — I’ve added that to the project understanding. What else should the first version accomplish?";
  const assistantMessage: InterviewMessage = {
    id: `message_${Date.now().toString(36)}_assistant`,
    projectId: input.memory.projectId,
    sessionId: input.session.id,
    role: "assistant",
    content: input.assistantContent?.trim() || generatedAssistantContent,
    source: "system",
    createdAt: now,
  };

  return {
    memory,
    session: {
      ...input.session,
      status: memory.completeness.level === "ready" ? "complete" : "active",
      nextQuestion: next,
      turnCount: input.session.turnCount + 1,
      updatedAt: now,
    },
    userMessage,
    assistantMessage,
  };
}
