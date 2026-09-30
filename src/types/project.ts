import type { PlanResult } from "@/types";
import type {
  ConversationMessageSource,
  ModelMode,
  ModelRouteSummary,
  NextRecommendedAction,
  ProjectDecision,
  ProjectPhase,
  ProjectArtifact,
} from "@/types/conversation";

/**
 * Shared domain contracts for the persistent Promgent project workflow.
 *
 * These types deliberately live outside the UI and backend adapters. The
 * database, interview engine and future repository-review flow all speak the
 * same language, while the existing planning contracts remain reusable internally.
 */

export type PlanningDepth = "fast" | "balanced" | "thorough";

export interface ProjectReference {
  id: string;
  projectId: string;
  type: "image" | "website" | "file";
  source: string;
  metadata: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectUsageEvent {
  phase: string;
  source: "promgent" | "external_snapshot";
  model?: string;
  cost: number;
  estimated: boolean;
  createdAt: string;
}

export interface ProjectUsageSummary {
  budget: number;
  used: number;
  remaining: number;
  events: ProjectUsageEvent[];
  estimated: boolean;
  updatedAt: string;
}

export type ProjectStatus =
  | "intake"
  | "interviewing"
  | "reviewing_requirements"
  | "srs_ready"
  | "approved"
  | "implementation"
  | "reviewing_repository"
  | "iterating"
  | "completed";

export type RequirementType =
  | "business"
  | "functional"
  | "non_functional"
  | "design"
  | "technical"
  | "data"
  | "security"
  | "integration"
  | "acceptance";

export type RequirementPriority = "critical" | "high" | "medium" | "low";

export type RequirementSource = "user" | "ai_inferred" | "reference" | "system";

export type RequirementStatus = "inferred" | "proposed" | "confirmed" | "rejected" | "superseded";

export interface AcceptanceCriterion {
  id: string;
  projectId: string;
  requirementId: string;
  description: string;
  source: RequirementSource;
  sourceMessageId?: string;
  status: RequirementStatus;
  confidence: "low" | "medium" | "high";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type RequirementArea =
  | "purpose"
  | "users"
  | "core_functionality"
  | "workflows"
  | "data"
  | "integrations"
  | "interfaces"
  | "security"
  | "performance"
  | "accessibility"
  | "deployment"
  | "constraints"
  | "acceptance_criteria";

export interface ProjectRecord {
  id: string;
  userId: string;
  title: string;
  initialDescription: string;
  projectType: string;
  selectedModel: string;
  modelMode?: ModelMode;
  planningDepth: PlanningDepth;
  creditBudget: number;
  status: ProjectStatus;
  phase?: ProjectPhase;
  nextRecommendedAction?: NextRecommendedAction | null;
  createdAt: string;
  updatedAt: string;
}

export interface Requirement {
  id: string;
  projectId: string;
  type: RequirementType;
  category: RequirementArea | string;
  description: string;
  priority: RequirementPriority;
  required: boolean;
  source: RequirementSource;
  sourceMessageId?: string;
  status: RequirementStatus;
  confidence: "low" | "medium" | "high";
  dependencies: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementUpdateProposal {
  action: "create" | "update" | "supersede" | "reject";
  requirementId?: string;
  type: RequirementType;
  category: RequirementArea | string;
  description: string;
  priority: RequirementPriority;
  required: boolean;
  status: RequirementStatus;
  confidence: "low" | "medium" | "high";
  dependencies: string[];
  reason: string;
}

export interface RequirementConflict {
  id: string;
  requirementIds: string[];
  description: string;
  explanation: string;
  resolved: boolean;
  resolution?: string;
}

export interface QuestionBacklogItem {
  id: string;
  question: string;
  area: RequirementArea | string;
  importance: number;
  informationGain: number;
  dependencyImpact: number;
  uncertainty: number;
  asked: boolean;
  resolved: boolean;
  source: "intake" | "answer" | "gap" | "contradiction";
}

export interface ProjectMemory {
  projectId: string;
  purpose: string;
  projectType: string;
  users: string[];
  secondaryUsers?: string[];
  administrators?: string[];
  stakeholders?: string[];
  mvpScope?: string[];
  deferredScope?: string[];
  rejectedIdeas?: string[];
  futureIdeas?: string[];
  requirements: Requirement[];
  conflicts: RequirementConflict[];
  assumptions: string[];
  risks: string[];
  workflows?: string[];
  adminWorkflows?: string[];
  decisions?: ProjectDecision[];
  proposedStack?: string[];
  confirmedStack?: string[];
  hosting?: string[];
  database?: string[];
  authentication?: string[];
  externalServices?: string[];
  apis?: string[];
  architectureSummary?: string;
  dataModel?: string[];
  references?: string[];
  constraints?: string[];
  currentImplementationState?: string;
  connectedRepository?: string | null;
  currentReviewedCommit?: string | null;
  knownProblems?: string[];
  nextRecommendedAction?: NextRecommendedAction | null;
  projectPhase?: ProjectPhase;
  artifactVersions?: Record<string, number>;
  creditEstimates?: Record<string, unknown>;
  creditUsage?: Record<string, unknown>;
  openQuestions: QuestionBacklogItem[];
  designPreferences: string[];
  technicalConstraints: string[];
  /** Legacy projects may still contain strings; persistence normalizes them on read. */
  acceptanceCriteria: Array<AcceptanceCriterion | string>;
  completeness: CompletenessResult;
  version: number;
  updatedAt: string;
}

export interface CompletenessResult {
  level: "insufficient" | "developing" | "ready";
  score: number;
  criticalGaps: string[];
  optionalGaps: string[];
  explanation: string;
}

export interface InterviewMessage {
  id: string;
  projectId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  source: ConversationMessageSource | "reference";
  artifactIds?: string[];
  modelRoute?: ModelRouteSummary;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface InterviewSession {
  id: string;
  projectId: string;
  planningDepth: PlanningDepth;
  status: "active" | "paused" | "complete";
  nextQuestion?: QuestionBacklogItem;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureVersion {
  id: string;
  projectId: string;
  version: number;
  diagramSource: string;
  summary: string;
  reasonForChange: string;
  createdAt: string;
}

export interface SrsDocument {
  id: string;
  projectId: string;
  version: number;
  title: string;
  content: string;
  requirementIds: string[];
  status: "draft" | "approved" | "superseded";
  createdAt: string;
}

export interface GuidedProjectSnapshot {
  project: ProjectRecord;
  memory: ProjectMemory;
  interview: InterviewSession;
  messages: InterviewMessage[];
  architecture?: ArchitectureVersion;
  srs?: SrsDocument;
  references?: ProjectReference[];
  artifacts?: ProjectArtifact[];
  implementationPlan?: PlanResult;
  usage: ProjectUsageSummary;
}
