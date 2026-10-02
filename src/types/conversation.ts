export type ProjectPhase = "exploring" | "shaping" | "ready_to_build" | "building" | "reviewing" | "improving" | "completed";
export type ModelMode = "auto" | "locked";

export type ConversationIntent =
  | "general_guidance" | "project_discovery" | "project_question"
  | "technical_explanation" | "requirement_change" | "architecture_request"
  | "architecture_discussion" | "build_plan_request" | "prompt_generation"
  | "credit_estimate_request" | "repository_review" | "live_product_review"
  | "testing_request" | "debugging_help" | "change_request"
  | "next_step_request" | "artifact_request";

export type ConversationMessageSource = "text" | "voice_transcript" | "image" | "website_reference" | "repository" | "live_url" | "system";

export type ArtifactType =
  | "project_blueprint" | "technical_blueprint" | "architecture" | "implementation_plan"
  | "implementation_prompt" | "correction_prompt" | "enhancement_prompt"
  | "test_plan" | "srs" | "requirements_snapshot" | "data_model"
  | "api_plan" | "deployment_plan" | "repository_review" | "live_product_review" | "cost_estimate";

export type ArtifactStatus = "draft" | "current" | "superseded" | "archived";

export interface ProjectArtifact {
  id: string;
  projectId: string;
  type: ArtifactType;
  version: number;
  title: string;
  content: string;
  structuredData: Record<string, unknown>;
  sourceMessageId?: string;
  supersedesArtifactId?: string;
  status: ArtifactStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDecision {
  id: string;
  projectId: string;
  decision: string;
  reason: string;
  source: "user" | "assistant_proposal" | "system";
  sourceMessageId?: string;
  confidence: "low" | "medium" | "high";
  status: "proposed" | "confirmed" | "rejected" | "superseded";
  createdAt: string;
  updatedAt: string;
}

export interface ModelRouteSummary {
  taskClass: string;
  chosenModel: string;
  reasonCode: string;
  expectedCostClass: "low" | "medium" | "high";
  fallbackUsed: boolean;
  estimated?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost: number;
    estimated: boolean;
  };
}

export interface EngineeringGuidance {
  assessment: string;
  recommendation: string;
  rationale: string[];
  mvpNow: string[];
  defer: string[];
  risks: string[];
  overview?: string;
  productBehavior?: string;
  technicalApproach?: string;
  architectureExplanation?: string;
  features?: Array<{
    name: string;
    explanation: string;
    whyItMatters?: string;
  }>;
  stack?: Array<{
    technology: string;
    purpose: string;
    reason: string;
  }>;
  userJourney?: Array<{
    step: string;
    explanation: string;
  }>;
  screens?: Array<{
    name: string;
    purpose: string;
    keyElements: string[];
  }>;
  riskMitigations?: Array<{
    risk: string;
    mitigation: string;
  }>;
  nextDecision?: string;
}

export interface ProjectAction {
  id: string;
  type: "view_artifact" | "generate_blueprint" | "generate_architecture" | "generate_prompt" | "estimate_credit" | "review_repository" | "run_tests" | "discuss_decision" | "apply_project_change";
  label: string;
  payload?: Record<string, unknown>;
}

export interface NextRecommendedAction { type: string; label: string; reason: string; }

export interface BriefRequirementPatch {
  action: "add" | "change" | "remove";
  requirementId?: string;
  previousDescription?: string;
  description?: string;
  type?: "business" | "functional" | "non_functional" | "design" | "technical" | "data" | "security" | "integration" | "acceptance";
  category?: string;
  priority?: "critical" | "high" | "medium" | "low";
  required?: boolean;
  reason?: string;
}

export interface ProjectBriefPatch {
  goal?: string;
  targetUsers?: { add: string[]; remove: string[] };
  features?: BriefRequirementPatch[];
  techChoices?: { add: string[]; remove: string[] };
  constraints?: { add: string[]; remove: string[] };
  decisions?: { add: Array<{ decision: string; reason: string }>; remove: string[] };
  openQuestions?: { add: string[]; resolve: string[] };
  architecture?: { changed: boolean; summary?: string; reason?: string };
}

export interface PromgentResponseProposal {
  message: string;
  intents: ConversationIntent[];
  guidance?: EngineeringGuidance;
  briefPatch?: ProjectBriefPatch;
  memoryChanges: unknown[];
  decisions: Array<Omit<ProjectDecision, "id" | "projectId" | "createdAt" | "updatedAt">>;
  artifactRequests: Array<{ type: ArtifactType; title?: string; reason: string; content?: string; structuredData?: Record<string, unknown> }>;
  suggestedActions: ProjectAction[];
  nextRecommendedAction?: NextRecommendedAction;
}

export interface RepositoryTestRun {
  id: string;
  projectId: string;
  repositoryUrl: string;
  commitSha: string;
  commands: string[];
  runner: "disabled" | "github_actions" | "isolated_container";
  status: "awaiting_authorization" | "queued" | "running" | "passed" | "failed" | "unavailable";
  authorizedAt?: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  summary?: string;
  createdAt: string;
}
