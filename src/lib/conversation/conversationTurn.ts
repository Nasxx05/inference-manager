import { createUuid } from "@/lib/ids";
import type { ConversationIntent, PromgentResponseProposal } from "@/types/conversation";
import type { InterviewMessage, InterviewSession, ProjectMemory } from "@/types/project";
import { calculateCompleteness } from "@/lib/projectMemory/completeness";
import { detectContradictions } from "@/lib/projectMemory/contradictions";
import { applyProjectBriefPatch } from "./projectBriefPatch";
import { phaseForConversation, recommendNextAction } from "./nextAction";

export function applyConversationTurn(input: {
  memory: ProjectMemory;
  session: InterviewSession;
  content: string;
  source: InterviewMessage["source"];
  intents: ConversationIntent[];
  response: PromgentResponseProposal;
  structuredMemoryProposal?: unknown;
  now?: string;
  generateId?: () => string;
}) {
  const now = input.now ?? new Date().toISOString();
  const generateId = input.generateId ?? createUuid;
  const userMessage: InterviewMessage = { id: generateId(), projectId: input.memory.projectId, sessionId: input.session.id, role: "user", content: input.content.trim(), source: input.source, createdAt: now };
  let memory = input.memory;
  if (input.response.briefPatch) {
    const patched = applyProjectBriefPatch({ memory, patch: input.response.briefPatch, sourceMessageId: userMessage.id, now, generateId });
    const conflicts = detectContradictions({ ...patched.memory, completeness: memory.completeness });
    memory = { ...patched.memory, conflicts, completeness: calculateCompleteness({ ...patched.memory, conflicts }, input.session.planningDepth) };
  }
  const phase = phaseForConversation(memory, input.intents);
  const nextRecommendedAction = input.response.nextRecommendedAction ?? recommendNextAction(memory, phase);
  if (memory.projectPhase !== phase || memory.nextRecommendedAction?.type !== nextRecommendedAction.type) {
    memory = { ...memory, projectPhase: phase, nextRecommendedAction, ...(memory.version === input.memory.version ? { version: memory.version + 1, updatedAt: now } : {}) };
  }
  const assistantMessage: InterviewMessage = {
    id: generateId(), projectId: memory.projectId, sessionId: input.session.id, role: "assistant",
    content: input.response.message, source: "system", createdAt: now,
  };
  return {
    memory,
    userMessage,
    assistantMessage,
    actions: input.response.suggestedActions,
    artifactRequests: input.response.artifactRequests,
    session: { ...input.session, status: "active" as const, turnCount: input.session.turnCount + 1, updatedAt: now },
  };
}
