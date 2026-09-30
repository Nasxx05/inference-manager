export type StackStatus = "proposed" | "confirmed" | "existing";

export interface StackChoice {
  technology: string;
  purpose: string;
  rationale: string;
  status: StackStatus;
  source: "user" | "promgent" | "repository";
}

export interface RecommendedStack {
  frontend?: StackChoice;
  backend?: StackChoice;
  database?: StackChoice;
  authentication?: StackChoice;
  storage?: StackChoice;
  hosting?: StackChoice;
  styling?: StackChoice;
  testing?: StackChoice;
  additional: StackChoice[];
}

export interface SystemComponent {
  id: string;
  name: string;
  responsibility: string;
  technology?: string;
  communicatesWith: string[];
}

export interface WorkflowDefinition { name: string; actor: string; steps: string[]; failureBehavior: string[] }
export interface PageDefinition { route: string; name: string; purpose: string; visibleContent: string[]; actions: string[]; dataNeeded: string[] }
export interface DataFieldDefinition { name: string; type: string; required: boolean; constraints: string[] }
export interface DataEntityDefinition { name: string; purpose: string; fields: DataFieldDefinition[]; relationships: string[]; constraints: string[] }
export interface ApiDefinition { name: string; method: string; path?: string; authentication: string; request: string[]; validation: string[]; response: string }
export interface SecurityRequirement { area: string; behavior: string; rationale: string }
export interface IntegrationDefinition { name: string; purpose: string; direction: string; failureBehavior: string }
export interface ImplementationPhase { name: string; objective: string; deliverables: string[]; dependsOn: string[] }
export interface TestingStrategy { unit: string[]; integration: string[]; endToEnd: string[]; regression: string[] }
export interface DeploymentPlan { platform: string; steps: string[]; environmentVariables: string[]; releaseChecks: string[] }

export interface TechnicalBlueprint {
  projectId: string;
  version: number;
  memoryVersion: number;
  objective: string;
  targetUsers: string[];
  mvpScope: string[];
  excludedScope: string[];
  recommendedStack: RecommendedStack;
  systemComponents: SystemComponent[];
  workflows: WorkflowDefinition[];
  pages: PageDefinition[];
  dataEntities: DataEntityDefinition[];
  apiSurface: ApiDefinition[];
  security: SecurityRequirement[];
  integrations: IntegrationDefinition[];
  nonFunctionalRequirements: string[];
  implementationPhases: ImplementationPhase[];
  testingStrategy: TestingStrategy;
  deploymentPlan: DeploymentPlan;
  architecture: { summary: string; mermaid: string };
  assumptions: string[];
  risks: string[];
  acceptanceCriteria: string[];
  repository?: { url: string; reviewedCommit?: string; existingStack: string[]; relevantFiles: string[] };
  quality: "ready" | "incomplete";
  qualityWarnings: string[];
  generatedAt: string;
}

export type PromptDepth = "quick_fix" | "feature" | "major_feature" | "full_mvp" | "repository_correction" | "refactor" | "testing" | "deployment";

export interface PromptPlan {
  objective?: string;
  stackRationale: string[];
  componentResponsibilities: string[];
  pages: string[];
  workflows: string[];
  apiOperations: string[];
  securityConsiderations: string[];
  implementationPhases: string[];
  testingScenarios: string[];
}

export interface CompiledPrompt {
  title: string;
  content: string;
  depth: PromptDepth;
  quality: "ready" | "incomplete";
  warnings: string[];
  structuredData: Record<string, unknown>;
}
