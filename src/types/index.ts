export type TaskType =
  | "coding"
  | "web-development"
  | "research"
  | "writing"
  | "document-analysis"
  | "data-analysis"
  | "planning"
  | "creative"
  | "general";

export type Complexity = "low" | "medium" | "high" | "very-high";

export type OptimizationPreference = "minimize-cost" | "balanced" | "maximum-quality";

export type CapabilityTier = "light" | "standard" | "advanced" | "frontier";

export interface ModelConfig {
  id: string;
  displayName: string;
  provider: string;
  capabilityTier: CapabilityTier;
  /** Price per million input tokens, in CREDIT. */
  inputPrice: number;
  /** Price per million output tokens, in CREDIT. */
  outputPrice: number;
  /** 0-100 */
  codingCapability: number;
  /** 0-100 */
  reasoningCapability: number;
  /** 0-100 */
  researchCapability: number;
  contextWindow: number;
}

export interface TaskPhase {
  name: string;
  description: string;
  priority: "essential" | "recommended" | "optional";
  /** Share of the total execution cost, 0-1. */
  costWeight: number;
  estimatedCost: [number, number];
}

export interface TaskAnalysis {
  taskType: TaskType;
  summary: string;
  complexity: Complexity;
  requiredCapabilities: string[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  expectedIterations: number;
  toolRequirements: string[];
  phases: TaskPhase[];
  risks: string[];
  scopeAdjustments: string[];
}

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  baseExecutionCost: number;
  iterationCost: number;
  overheadCost: number;
  minimum: number;
  maximum: number;
  recommendedMaximum: number;
  safetyFactor: number;
  modelId: string;
}

export interface ReservePlan {
  totalBudget: number;
  initialExecution: number;
  recommendedReserve: number;
  unusedMargin: number;
  explanation: string;
}

export type FeasibilityStatus = "fits" | "fits-with-optimization" | "does-not-fit";

export interface FeasibilityResult {
  status: FeasibilityStatus;
  headline: string;
  detail: string;
}

export interface OptimizedScope {
  included: string[];
  deferred: string[];
  simplified: string[];
  rationale: string;
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  /** Short explanation of why this answer matters. */
  hint?: string;
  /** Applied when the user skips the question. */
  defaultValue: string;
  /**
   * Quick-pick choices. Multiple can be selected at once unless the question
   * is marked singleSelect. Free text is always allowed alongside them.
   */
  options?: string[];
  /** True when the options are mutually exclusive, so picking one clears the rest. */
  singleSelect?: boolean;
}

export interface ClarifyingAnswer {
  id: string;
  question: string;
  answer: string;
  /** False when the default was applied because the user skipped. */
  answered: boolean;
}

export interface ExecutionPlan {
  strategy: string;
  steps: string[];
  validationApproach: string;
  revisionPolicy: string;
}

export interface ModelRecommendation {
  modelId: string;
  displayName: string;
  estimated: number;
  reasons: string[];
}

export interface ModelComparisonRow {
  modelId: string;
  displayName: string;
  estimated: number;
  capability: CapabilityTier;
}

export interface PlanResult {
  id: string;
  createdAt: string;
  taskDescription: string;
  analysis: TaskAnalysis;
  modelId: string;
  autoSelected: boolean;
  optimization: OptimizationPreference;
  budget: number;
  cost: CostEstimate;
  reserve: ReservePlan;
  feasibility: FeasibilityResult;
  optimizedScope: OptimizedScope | null;
  scopeApplied: boolean;
  recommendation: ModelRecommendation | null;
  comparison: ModelComparisonRow[];
  executionPlan: ExecutionPlan;
  clarifyingAnswers: ClarifyingAnswer[];
  /** True when at least one clarifying question was answered rather than skipped. */
  answersUsed: boolean;
  /** "ai" when the internal model wrote the prompt, "compiled" on fallback. */
  promptSource: "ai" | "compiled";
  prompt: string;
  /**
   * The internal model that produced this plan (AGENTFUND_AI_MODEL).
   * Diagnostic only — this is NOT the user's target model, and it is never a
   * credential. Useful for confirming a model switch actually took effect.
   */
  agentModel?: string;
  /**
   * Time spent in each LLM stage, in milliseconds.
   *
   * The LLM calls are the only meaningful contributors to latency, so
   * reporting them separately makes a slow request diagnosable: the log and the
   * response both say whether the delay was in the model or in Promgent.
   */
  analysisDurationMs?: number;
  promptDurationMs?: number;

  /**
   * How the plan was produced: "combined" (one LLM call, the normal path) or
   * "two-call" (the fallback for models that cannot return both halves
   * together). Diagnostic only.
   */
  route?: "combined" | "two-call";
  /** Provider request id, correlating this plan with the server logs. */
  requestId?: string;
  /** LLM requests actually sent for this plan. */
  llmCalls?: number;
  /** Retries beyond the first attempt, across the whole plan. */
  retryCount?: number;
  /** End-to-end time for this plan, in milliseconds. */
  totalDurationMs?: number;
  /** Time spent inside LLM calls. */
  llmDurationMs?: number;
  /** Provider-reported generation time, when available. */
  providerDurationMs?: number;
  /** Time spent parsing and validating model output. */
  parseDurationMs?: number;
  /** Time spent in local deterministic calculations. */
  localDurationMs?: number;
}

export interface HistoryEntry {
  id: string;
  taskName: string;
  modelId: string;
  budget: number;
  estimatedCost: string;
  optimization: OptimizationPreference;
  prompt: string;
  timestamp: string;
}