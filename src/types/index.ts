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

/**
 * A target-model entry in Promgent's registry.
 *
 * Two identities are deliberately kept separate:
 *
 *  - `id` is Promgent's INTERNAL profile id. It is stable, appears in the UI,
 *    history and plan payloads, and must not change when a provider renames
 *    something.
 *  - `providerModelId` is the identifier that would be sent to the provider or
 *    gateway. It may be unset when the catalogue is curated and no specific
 *    provider id is being asserted.
 *
 * Capability scores are Promgent's internal suitability heuristics on a 0-100
 * scale — they are NOT benchmark rankings, and `profileSource` records that the
 * catalogue is curated static MVP data rather than fetched live.
 */
export interface ModelConfig {
  /** Stable internal profile id. Never rename: it is persisted in history. */
  id: string;
  displayName: string;
  provider: string;
  /**
   * The provider/gateway model identifier, when one is known.
   *
   * Optional by design: the curated MVP catalogue describes model families
   * rather than asserting exact provider ids, and Promgent never sends this
   * anywhere itself — the user executes the prompt in their own environment.
   */
  providerModelId?: string;
  capabilityTier: CapabilityTier;
  /** Price per million input tokens, in CREDIT. Curated static data. */
  inputPrice: number;
  /** Price per million output tokens, in CREDIT. Curated static data. */
  outputPrice: number;
  /** 0-100 internal heuristic, not a benchmark score. */
  codingCapability: number;
  /** 0-100 internal heuristic, not a benchmark score. */
  reasoningCapability: number;
  /** 0-100 internal heuristic, not a benchmark score. */
  researchCapability: number;
  contextWindow: number;
  /** Where this profile came from. "curated" means static MVP data. */
  profileSource?: "curated" | "live";
}

export interface TaskPhase {
  name: string;
  description: string;
  priority: "essential" | "recommended" | "optional";
  /** Share of the total execution cost, 0-1. */
  costWeight: number;
  estimatedCost: [number, number];
}

/**
 * How much work the task represents, on a 0-100 scale.
 *
 * The level is a label for people; the score is what the estimator actually
 * uses. Both exist because two "high complexity" tasks can differ enormously
 * in real workload, so a label alone cannot drive a cost.
 */
export type EffortLevel = "low" | "medium" | "high" | "very-high" | "extreme";

export type Confidence = "low" | "medium" | "high";

/**
 * Task effort, produced by the analyser and consumed by the estimator.
 *
 * `implementationSize` and `contextOverhead` are separate because they scale
 * cost differently: a large implementation costs output tokens, while heavy
 * context costs input tokens, and a task can be high in one and low in the
 * other (a long-document summary is high-context, low-implementation).
 */
export interface TaskEffort {
  level: EffortLevel;
  /** 0-100. */
  score: number;
  requirementCount: number;
  criticalRequirementCount: number;
  optionalRequirementCount: number;
  estimatedIterations: { min: number; max: number };
  /** 0-100: how much code/artifact is actually produced. */
  implementationSize: number;
  /** 0-100: how much context, research or document work is required. */
  contextOverhead: number;
  /** 0-100: how much tool/external-integration work is required. */
  toolOverhead: number;
  /** 0-100: expected debugging and revision load. */
  revisionLoad: number;
}

/**
 * What the task needs from a model, on the same 0-100 scales used by model
 * capability metadata. Comparing like-for-like is what keeps suitability
 * model-agnostic rather than a list of hard-coded model names.
 */
export interface TaskRequirementProfile {
  codingRequirement: number;
  reasoningRequirement: number;
  researchRequirement: number;
  contextRequirement: number;
  structuredOutputRequirement: number;
}

/** Per-phase token estimates, so cost is built up rather than guessed once. */
export interface PhaseTokens {
  input: number;
  output: number;
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
  /** Workload model. Optional so older/partial payloads still validate. */
  effort?: TaskEffort;
  /** Capability demands of the task, for the suitability engine. */
  requirementProfile?: TaskRequirementProfile;
  /** Per-phase token estimates keyed by phase name. */
  phaseTokens?: Record<string, PhaseTokens>;
  /** How well-specified the request is; low means the estimate is shaky. */
  confidence?: Confidence;
  /** Concrete reasons the estimate is what it is, shown to the user. */
  costDrivers?: string[];
}

/**
 * A PLANNING estimate, not a provider quote.
 *
 * Every figure here is derived locally from workload signals and the curated
 * pricing in the model registry. Nothing is fetched from a provider, and no
 * number should be read as a guaranteed bill.
 */
export interface CostEstimate {
  /** Estimated input/context tokens across all passes. */
  estimatedInputTokens: number;
  /** Estimated output/generation tokens across all passes. */
  estimatedOutputTokens: number;
  /** Cost of the estimated input tokens at the model's input rate. */
  inputCost: number;
  /** Cost of the estimated output tokens at the model's output rate. */
  outputCost: number;
  /** Tokens × rate for a single pass, before iterations and overhead. */
  baseExecutionCost: number;
  /** Estimated total inference cost including iterations and overhead. */
  estimatedInferenceCost: number;
  /** How many generation/validation/revision passes were modelled. */
  modelledPasses: number;
  /** Human-readable reasons this estimate is what it is. */
  costDrivers: string[];
  /**
   * Whether pricing came from curated static data or a live source. Drives the
   * UI disclaimer, so the product never implies a live quote.
   */
  pricingSource: "curated" | "live";
  iterationCost: number;
  overheadCost: number;
  contextOverheadCost: number;
  toolOverheadCost: number;
  revisionCost: number;
  minimum: number;
  maximum: number;
  /**
   * The approximate amount below which the core scope is unlikely to be
   * completed reliably. Distinct from the recommended maximum: this is a floor,
   * not a target, and it is an estimate, not a guarantee.
   */
  minimumViable: number;
  recommendedMaximum: number;
  confidence: Confidence;
  safetyFactor: number;
  modelId: string;
  effort?: TaskEffort;
}

export interface ReservePlan {
  totalBudget: number;
  initialExecution: number;
  recommendedReserve: number;
  unusedMargin: number;
  explanation: string;
}

/**
 * Feasibility now distinguishes a tight-but-possible budget from one that is
 * clearly insufficient, so the user gets an actionable answer rather than a
 * single "over budget" verdict.
 */
export type FeasibilityStatus =
  | "fits"
  | "tight"
  | "fits-with-optimization"
  | "does-not-fit";

export interface FeasibilityResult {
  status: FeasibilityStatus;
  headline: string;
  detail: string;
}

export type SuitabilityStatus = "suitable" | "acceptable" | "not-recommended";

/**
 * Model-task compatibility, deliberately independent from budget feasibility.
 *
 * "Can this model handle it?" and "can the user afford it?" are different
 * questions; collapsing them hides the fix (stronger model vs. more budget).
 */
export interface ModelSuitability {
  status: SuitabilityStatus;
  /** Short human-readable summary for the UI. */
  headline: string;
  reasons: string[];
  capabilityGaps: string[];
  suggestedModelId?: string;
  suggestedModelName?: string;
  /** Extra CREDIT implied by switching to the suggestion, when computable. */
  suggestedDelta?: number;
  /** True when the user knowingly kept a model we advised against. */
  overridden: boolean;
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
  /** The concrete model Auto resolved to, when Auto was used. */
  resolvedModelId?: string;
  /** Why that model was chosen, when Auto was used. */
  resolvedModelReason?: string;
  /**
   * True when every safe reduction was applied and the budget is still short.
   * Lets the UI state insufficiency plainly instead of implying feasibility.
   */
  optimizationInsufficient?: boolean;
  recommendation: ModelRecommendation | null;
  comparison: ModelComparisonRow[];
  suitability: ModelSuitability | null;
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
