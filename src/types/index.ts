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
  prompt: string;
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