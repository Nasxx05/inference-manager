import type { ProjectPhase } from "@/types/conversation";
import type { ProjectMemory, ProjectStatus } from "@/types/project";

const PHASE_BY_LEGACY_STATUS: Record<ProjectStatus, ProjectPhase> = {
  intake: "exploring", interviewing: "shaping", reviewing_requirements: "shaping",
  srs_ready: "ready_to_build", approved: "ready_to_build", implementation: "building",
  reviewing_repository: "reviewing", iterating: "improving", completed: "completed",
};

export function phaseForLegacyStatus(status: ProjectStatus): ProjectPhase {
  return PHASE_BY_LEGACY_STATUS[status] ?? "exploring";
}

/** Add conversation-era fields without discarding any legacy memory JSON. */
export function normalizeProjectMemory(memory: ProjectMemory): ProjectMemory {
  return {
    ...memory,
    secondaryUsers: memory.secondaryUsers ?? [], administrators: memory.administrators ?? [], stakeholders: memory.stakeholders ?? [],
    mvpScope: memory.mvpScope ?? [], deferredScope: memory.deferredScope ?? [], rejectedIdeas: memory.rejectedIdeas ?? [], futureIdeas: memory.futureIdeas ?? [],
    workflows: memory.workflows ?? [], adminWorkflows: memory.adminWorkflows ?? [], decisions: memory.decisions ?? [],
    proposedStack: memory.proposedStack ?? [], confirmedStack: memory.confirmedStack ?? [], hosting: memory.hosting ?? [], database: memory.database ?? [], authentication: memory.authentication ?? [], externalServices: memory.externalServices ?? [], apis: memory.apis ?? [],
    architectureSummary: memory.architectureSummary ?? "", dataModel: memory.dataModel ?? [], references: memory.references ?? [], constraints: memory.constraints ?? [],
    currentImplementationState: memory.currentImplementationState ?? "", connectedRepository: memory.connectedRepository ?? null, currentReviewedCommit: memory.currentReviewedCommit ?? null, knownProblems: memory.knownProblems ?? [],
    nextRecommendedAction: memory.nextRecommendedAction ?? null, projectPhase: memory.projectPhase ?? "exploring", artifactVersions: memory.artifactVersions ?? {}, creditEstimates: memory.creditEstimates ?? {}, creditUsage: memory.creditUsage ?? {},
  };
}
