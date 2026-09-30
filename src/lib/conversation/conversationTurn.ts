import { createUuid } from "@/lib/ids";
import type { ConversationIntent, PromgentResponseProposal } from "@/types/conversation";
import type { InterviewMessage, InterviewSession, ProjectMemory } from "@/types/project";
import { calculateCompleteness } from "@/lib/projectMemory/completeness";
import { detectContradictions } from "@/lib/projectMemory/contradictions";
import { validateInterviewProposal } from "@/lib/projectMemory/proposals";
import { intentMayChangeProject } from "./intentRouter";
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
  const mayChange = input.intents.some(intentMayChangeProject);
  let memory = input.memory;
  if (mayChange) {
    const proposal = validateInterviewProposal({ raw: input.structuredMemoryProposal, memory, userContent: input.content, sourceMessageId: userMessage.id, now, fallbackToUserContent: true });
    const draft = {
      ...memory,
      requirements: proposal.requirements,
      acceptanceCriteria: proposal.acceptanceCriteria,
      users: [...new Set([...memory.users, ...proposal.users])],
      assumptions: [...new Set([...memory.assumptions, ...proposal.assumptions])],
      designPreferences: [...new Set([...memory.designPreferences, ...proposal.designPreferences])],
      technicalConstraints: [...new Set([...memory.technicalConstraints, ...proposal.technicalConstraints])],
      mvpScope: [...new Set([...(memory.mvpScope ?? []), ...proposal.mvpScope])],
      deferredScope: [...new Set([...(memory.deferredScope ?? []), ...proposal.deferredScope])],
      rejectedIdeas: [...new Set([...(memory.rejectedIdeas ?? []), ...proposal.rejectedIdeas])],
      futureIdeas: [...new Set([...(memory.futureIdeas ?? []), ...proposal.futureIdeas])],
      workflows: [...new Set([...(memory.workflows ?? []), ...proposal.workflows])],
      adminWorkflows: [...new Set([...(memory.adminWorkflows ?? []), ...proposal.adminWorkflows])],
      proposedStack: [...new Set([...(memory.proposedStack ?? []), ...proposal.proposedStack])],
      confirmedStack: [...new Set([...(memory.confirmedStack ?? []), ...proposal.confirmedStack])],
      hosting: [...new Set([...(memory.hosting ?? []), ...proposal.hosting])],
      database: [...new Set([...(memory.database ?? []), ...proposal.database])],
      authentication: [...new Set([...(memory.authentication ?? []), ...proposal.authentication])],
      externalServices: [...new Set([...(memory.externalServices ?? []), ...proposal.externalServices])],
      apis: [...new Set([...(memory.apis ?? []), ...proposal.apis])],
      dataModel: [...new Set([...(memory.dataModel ?? []), ...proposal.dataModel])],
      risks: [...new Set([...memory.risks, ...proposal.risks])],
      constraints: [...new Set([...(memory.constraints ?? []), ...proposal.constraints])],
      knownProblems: [...new Set([...(memory.knownProblems ?? []), ...proposal.knownProblems])],
      architectureSummary: proposal.architectureSummary || memory.architectureSummary,
      decisions: [
        ...(memory.decisions ?? []),
        ...input.response.decisions.map((decision) => ({
          ...decision,
          id: generateId(),
          projectId: memory.projectId,
          sourceMessageId: userMessage.id,
          createdAt: now,
          updatedAt: now,
        })),
      ],
      version: memory.version + 1,
      updatedAt: now,
    };
    const conflicts = detectContradictions({ ...draft, completeness: memory.completeness });
    memory = { ...draft, conflicts, completeness: calculateCompleteness({ ...draft, conflicts }, input.session.planningDepth) };
  }
  const phase = phaseForConversation(memory, input.intents);
  const nextRecommendedAction = input.response.nextRecommendedAction ?? recommendNextAction(memory, phase);
  if (mayChange || memory.projectPhase !== phase || memory.nextRecommendedAction?.type !== nextRecommendedAction.type) {
    memory = { ...memory, projectPhase: phase, nextRecommendedAction, ...(!mayChange ? { version: memory.version + 1, updatedAt: now } : {}) };
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
