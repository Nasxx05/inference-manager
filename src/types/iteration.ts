import type { ArchitectureVersion, ProjectMemory, Requirement, SrsDocument } from "./project";

export type IterationStatus =
  | "draft"
  | "collecting_context"
  | "analyzing"
  | "review_ready"
  | "discussing"
  | "changes_approved"
  | "prompt_ready"
  | "implementation_in_progress"
  | "ready_for_rereview"
  | "completed";

export type ChangeRequestCategory =
  | "feature_change" | "feature_addition" | "feature_removal" | "visual_change"
  | "usability_change" | "technical_change" | "content_change" | "bug_report"
  | "performance_change" | "other";

export type ChangeRequestStatus = "proposed" | "clarified" | "accepted" | "rejected" | "implemented" | "verified";
export type FindingType = "required_fix" | "user_change" | "technical_concern" | "optional_opportunity";
export type FindingStatus = "open" | "discussed" | "accepted" | "rejected" | "deferred" | "resolved" | "verified";
export type EvidenceType = "repository_file" | "repository_structure" | "live_url" | "screenshot" | "user_message" | "project_state";
export type TraceabilityStatus = "satisfied" | "partially_satisfied" | "missing" | "conflicting" | "cannot_verify";
export type ImpactLevel = "low" | "medium" | "high";

export interface RepositorySnapshot {
  repositoryUrl: string;
  owner?: string;
  name?: string;
  branch?: string;
  commitSha?: string;
  reviewedAt: string;
  fileCount: number;
  relevantFiles: string[];
  structuralSummary: string;
  evidenceText: string;
  status: "reviewed" | "unavailable" | "partial";
  error?: string;
}

export interface LiveProductSnapshot {
  url: string;
  inspectedAt: string;
  status: "reviewed" | "unavailable";
  title?: string;
  headings?: string[];
  sections?: string[];
  components?: string[];
  textSample?: string;
  error?: string;
}

export interface IterationInput {
  id: string;
  iterationId: string;
  projectId: string;
  text?: string;
  voiceTranscript?: string;
  screenshotIds: string[];
  repositoryUrl?: string;
  liveUrl?: string;
  createdAt: string;
}

export interface ChangeRequest {
  id: string;
  iterationId: string;
  projectId: string;
  category: ChangeRequestCategory;
  description: string;
  rationale?: string;
  source: "user_text" | "voice_transcript" | "suggestion" | "discussion";
  sourceMessageId?: string;
  priority: "low" | "medium" | "high" | "critical";
  status: ChangeRequestStatus;
  createdAt: string;
}

export interface ReviewEvidence {
  id: string;
  type: EvidenceType;
  repositoryFile?: string;
  lineRange?: string;
  route?: string;
  component?: string;
  liveUrl?: string;
  userMessageId?: string;
  explanation: string;
  confidence: "low" | "medium" | "high";
}

export interface TraceabilityRecord {
  id: string;
  iterationId: string;
  projectId: string;
  requirementId: string;
  requirementDescription: string;
  status: TraceabilityStatus;
  acceptanceCriteria: string[];
  evidenceIds: string[];
  explanation: string;
  confidence: "low" | "medium" | "high";
}

export interface ReviewFinding {
  id: string;
  iterationId: string;
  projectId: string;
  type: FindingType;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  plainLanguage?: string;
  requirementIds: string[];
  acceptanceCriteriaIds: string[];
  evidenceIds: string[];
  confidence: "low" | "medium" | "high";
  impact: string;
  implementationComplexity: ImpactLevel;
  architectureAffected: boolean;
  specificationAffected: boolean;
  status: FindingStatus;
  createdAt: string;
}

export interface ProjectSuggestion {
  id: string;
  projectId: string;
  iterationId: string;
  title: string;
  description: string;
  rationale: string;
  expectedBenefit: string;
  implementationImpact: ImpactLevel;
  architectureAffected: boolean;
  requirementsAffected: string[];
  confidence: "low" | "medium" | "high";
  status: "proposed" | "discussing" | "accepted" | "rejected" | "deferred";
  createdAt: string;
}

export interface ProjectDecision {
  id: string;
  projectId: string;
  iterationId: string;
  decisionType: "finding" | "suggestion" | "change_request" | "project_complete";
  subjectId: string;
  decision: "accepted" | "rejected" | "deferred" | "approved" | "ignored";
  rationale?: string;
  createdAt: string;
}

export interface IterationReport {
  requirementsReviewed: number;
  satisfied: number;
  partial: number;
  missing: number;
  conflicting: number;
  cannotVerify: number;
  requiredFixes: number;
  technicalConcerns: number;
  userChanges: number;
  optionalSuggestions: number;
  summary: string;
  modelSummary?: string;
}

export interface IterationPrompt {
  id: string;
  projectId: string;
  iterationId: string;
  kind: "correction" | "enhancement" | "mixed";
  reviewedCommitSha?: string;
  baseSrsVersionId?: string;
  baseArchitectureVersionId?: string;
  prompt: string;
  createdAt: string;
}

export interface ProjectIteration {
  id: string;
  projectId: string;
  sequenceNumber: number;
  title: string;
  status: IterationStatus;
  baseSrsVersionId?: string;
  baseArchitectureVersionId?: string;
  resultingSrsVersionId?: string;
  resultingArchitectureVersionId?: string;
  input?: IterationInput;
  repositorySnapshot?: RepositorySnapshot;
  liveProductSnapshot?: LiveProductSnapshot;
  changeRequests: ChangeRequest[];
  findings: ReviewFinding[];
  evidence: ReviewEvidence[];
  traceability: TraceabilityRecord[];
  suggestions: ProjectSuggestion[];
  decisions: ProjectDecision[];
  report?: IterationReport;
  generatedPrompt?: IterationPrompt;
  startedAt: string;
  reviewedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface IterationContext {
  project: { id: string; title: string; selectedModel: string; planningDepth: string };
  memory: ProjectMemory;
  requirements: Requirement[];
  srs?: SrsDocument;
  architecture?: ArchitectureVersion;
}
