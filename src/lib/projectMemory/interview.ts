import type { InterviewMessage, InterviewSession, ProjectMemory } from "@/types/project";
import { createUuid } from "@/lib/ids";
import { nextBestQuestion, refreshQuestionBacklog } from "./backlog";
import { calculateCompleteness } from "./completeness";
import { detectContradictions } from "./contradictions";
import { validateInterviewProposal } from "./proposals";

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
  structuredProposal?: unknown;
  now?: string;
  generateId?: () => string;
}): InterviewTurnResult {
  const now = input.now ?? new Date().toISOString();
  const generateId = input.generateId ?? createUuid;
  const content = input.content.trim();
  const userMessage: InterviewMessage = {
    id: generateId(),
    projectId: input.memory.projectId,
    sessionId: input.session.id,
    role: "user",
    content,
    source: input.source ?? "text",
    createdAt: now,
  };

  const proposal = validateInterviewProposal({ raw: input.structuredProposal, memory: input.memory, userContent: content, sourceMessageId: userMessage.id, now });
  const draft: Omit<ProjectMemory, "completeness"> = {
    ...input.memory,
    requirements: proposal.requirements,
    acceptanceCriteria: proposal.acceptanceCriteria,
    users: [...new Set([...input.memory.users, ...proposal.users])],
    assumptions: [...new Set([...input.memory.assumptions, ...proposal.assumptions])],
    designPreferences: [...new Set([...input.memory.designPreferences, ...proposal.designPreferences])],
    technicalConstraints: [...new Set([...input.memory.technicalConstraints, ...proposal.technicalConstraints])],
    mvpScope: [...new Set([...(input.memory.mvpScope ?? []), ...proposal.mvpScope])],
    deferredScope: [...new Set([...(input.memory.deferredScope ?? []), ...proposal.deferredScope])],
    rejectedIdeas: [...new Set([...(input.memory.rejectedIdeas ?? []), ...proposal.rejectedIdeas])],
    futureIdeas: [...new Set([...(input.memory.futureIdeas ?? []), ...proposal.futureIdeas])],
    workflows: [...new Set([...(input.memory.workflows ?? []), ...proposal.workflows])],
    adminWorkflows: [...new Set([...(input.memory.adminWorkflows ?? []), ...proposal.adminWorkflows])],
    proposedStack: [...new Set([...(input.memory.proposedStack ?? []), ...proposal.proposedStack])],
    confirmedStack: [...new Set([...(input.memory.confirmedStack ?? []), ...proposal.confirmedStack])],
    hosting: [...new Set([...(input.memory.hosting ?? []), ...proposal.hosting])],
    database: [...new Set([...(input.memory.database ?? []), ...proposal.database])],
    authentication: [...new Set([...(input.memory.authentication ?? []), ...proposal.authentication])],
    externalServices: [...new Set([...(input.memory.externalServices ?? []), ...proposal.externalServices])],
    apis: [...new Set([...(input.memory.apis ?? []), ...proposal.apis])],
    dataModel: [...new Set([...(input.memory.dataModel ?? []), ...proposal.dataModel])],
    risks: [...new Set([...input.memory.risks, ...proposal.risks])],
    constraints: [...new Set([...(input.memory.constraints ?? []), ...proposal.constraints])],
    knownProblems: [...new Set([...(input.memory.knownProblems ?? []), ...proposal.knownProblems])],
    architectureSummary: proposal.architectureSummary || input.memory.architectureSummary,
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
    id: generateId(),
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
