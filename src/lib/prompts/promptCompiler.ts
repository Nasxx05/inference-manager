import type { ProjectMemory } from "@/types/project";
import type { CompiledPrompt, PromptDepth, PromptPlan, StackChoice, TechnicalBlueprint } from "@/types/technicalBlueprint";

function bullets(values: string[], empty = "No additional items recorded."): string {
  return values.length ? values.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}
function numbered(values: string[]): string { return values.length ? values.map((item, index) => `${index + 1}. ${item}`).join("\n") : "1. Follow the confirmed behavior and verify the result."; }
function stackChoices(blueprint: TechnicalBlueprint): StackChoice[] {
  const stack = blueprint.recommendedStack;
  return [stack.frontend, stack.backend, stack.database, stack.authentication, stack.storage, stack.hosting, stack.styling, stack.testing, ...stack.additional].filter((item): item is StackChoice => Boolean(item));
}

export function inferPromptDepth(input: { userRequest: string; memory: ProjectMemory; kind?: string; hasRepository?: boolean }): PromptDepth {
  const request = input.userRequest.toLowerCase();
  if (input.hasRepository && /fix|correct|repair|review finding|issue|bug/.test(request)) return "repository_correction";
  if (/deploy|hosting|production release/.test(request)) return "deployment";
  if (/test|coverage|e2e|regression/.test(request) && !/full|complete|mvp/.test(request)) return "testing";
  if (/refactor|restructure|migrate/.test(request)) return "refactor";
  if (/quick|small|minor|just fix|overflow|typo|spacing|color/.test(request)) return "quick_fix";
  if (/generate|create|write|regenerate/.test(request) && /implementation prompt|build prompt|coding prompt/.test(request)) return "full_mvp";
  if (/full|complete|entire|first version|mvp|build the (?:app|site|website|platform)/.test(request) || input.memory.projectPhase === "ready_to_build") return "full_mvp";
  if (/major|across|end.to.end|workflow/.test(request)) return "major_feature";
  return "feature";
}

export function validatePromptPlan(value: unknown): PromptPlan {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (item: unknown, max = 1200) => typeof item === "string" ? item.trim().slice(0, max) : "";
  const strings = (item: unknown, limit = 20) => Array.isArray(item) ? [...new Set(item.map((entry) => text(typeof entry === "string" ? entry : "")).filter(Boolean))].slice(0, limit) : [];
  return {
    ...(text(root.objective, 2000) ? { objective: text(root.objective, 2000) } : {}),
    stackRationale: strings(root.stackRationale),
    componentResponsibilities: strings(root.componentResponsibilities, 30),
    pages: strings(root.pages, 20),
    workflows: strings(root.workflows, 20),
    apiOperations: strings(root.apiOperations, 30),
    securityConsiderations: strings(root.securityConsiderations, 20),
    implementationPhases: strings(root.implementationPhases, 12),
    testingScenarios: strings(root.testingScenarios, 30),
  };
}

function verificationCommands(blueprint: TechnicalBlueprint): string[] {
  const technologies = stackChoices(blueprint).map((item) => item.technology).join(" ").toLowerCase();
  if (/django|fastapi|python/.test(technologies)) return ["Run the repository's Python test command (for example pytest when configured).", "Run the configured Python lint/type checks.", "Build the frontend if the repository contains one."];
  if (/next|react|typescript|node|expo/.test(technologies)) return ["Run the repository's configured test command.", "Run the configured lint command.", "Run the configured TypeScript typecheck command when present.", "Run the production build command."];
  return ["Inspect package and build configuration, then run only the test, lint, typecheck, and build commands actually defined by the repository."];
}

function compactPrompt(input: CompilePromptInput, depth: PromptDepth): CompiledPrompt {
  const blueprint = input.technicalBlueprint;
  const relevantCriteria = blueprint.acceptanceCriteria.slice(0, 12);
  const content = [
    `# ${input.title ?? (depth === "quick_fix" ? "Focused correction" : "Feature implementation")}`,
    "", "## Role", "Act as a senior engineer working inside the existing codebase. Inspect the affected path first, preserve unrelated working behavior, and make the smallest coherent change.",
    "", "## Objective", input.userRequest.trim() || blueprint.objective,
    "", "## Relevant Context", bullets([input.memory.currentImplementationState ?? "", ...(input.promptPlan?.componentResponsibilities ?? [])].filter(Boolean).slice(0, 8)),
    "", "## Relevant Architecture", blueprint.architecture.summary,
    "", "```mermaid", blueprint.architecture.mermaid, "```",
    "", "## Required Behavior", bullets(blueprint.mvpScope.slice(0, depth === "quick_fix" ? 5 : 12)),
    "", "## Acceptance Criteria", bullets(relevantCriteria),
    "", "## Testing", bullets(blueprint.testingStrategy.regression.slice(0, 6)),
    "", "## Do Not Change", bullets(blueprint.excludedScope, "Do not change unrelated working behavior or rebuild the application."),
    "", "## Verification", bullets(verificationCommands(blueprint)),
    "", "## Final Report", "Report files changed, behavior delivered, checks actually executed and their results, and any remaining limitation.",
  ].join("\n");
  return result(input, depth, content);
}

export interface CompilePromptInput {
  kind: "implementation" | "correction" | "enhancement";
  depth?: PromptDepth;
  title?: string;
  memory: ProjectMemory;
  technicalBlueprint: TechnicalBlueprint;
  userRequest: string;
  promptPlan?: PromptPlan;
  reviewFindings?: string[];
}

function result(input: CompilePromptInput, depth: PromptDepth, content: string): CompiledPrompt {
  const validation = validateCompiledPrompt(content, depth);
  return {
    title: input.title?.trim() || (depth === "full_mvp" ? "Comprehensive implementation prompt" : input.kind === "correction" ? "Repository correction prompt" : "Implementation prompt"),
    content,
    depth,
    quality: input.technicalBlueprint.quality === "incomplete" || validation.warnings.length ? "incomplete" : "ready",
    warnings: [...new Set([...input.technicalBlueprint.qualityWarnings, ...validation.warnings])],
    structuredData: { promptDepth: depth, memoryVersion: input.memory.version, blueprintVersion: input.technicalBlueprint.version, architectureVersion: input.technicalBlueprint.version, ...(input.technicalBlueprint.repository?.reviewedCommit ? { reviewedCommitSHA: input.technicalBlueprint.repository.reviewedCommit } : {}) },
  };
}

export function compileImplementationPrompt(input: CompilePromptInput): CompiledPrompt {
  const blueprint = input.technicalBlueprint;
  const depth = input.depth ?? inferPromptDepth({ userRequest: input.userRequest, memory: input.memory, kind: input.kind, hasRepository: Boolean(blueprint.repository) });
  if (depth === "quick_fix" || depth === "feature" || depth === "testing" || depth === "deployment") return compactPrompt(input, depth);
  const stack = stackChoices(blueprint);
  const roles = blueprint.targetUsers.map((user) => `${user}: may perform only the workflows and protected actions explicitly assigned to this role.`);
  const content = [
    `# ${input.title?.trim() || (depth === "repository_correction" ? "Repository correction" : "Production-ready MVP implementation")}`,
    "", "## Role", blueprint.repository ? "Act as a senior product engineer working inside the existing repository. Inspect the current code first, preserve working behavior, do not recreate the project from scratch, and make the smallest coherent set of changes that satisfies this specification." : "Act as a senior full-stack product engineer responsible for implementing the first production-ready version of this project.",
    "", "## Objective", input.promptPlan?.objective || blueprint.objective,
    "", "## Product Context", `Target users:\n${bullets(blueprint.targetUsers)}\n\nDesired outcome:\n${blueprint.objective}`,
    "", "## MVP Scope", bullets(blueprint.mvpScope),
    "", "## Out of Scope", bullets(blueprint.excludedScope, "Do not add features beyond the listed MVP scope."),
    ...(blueprint.repository ? ["", "## Existing Repository", `Repository: ${blueprint.repository.url}\nReviewed commit: ${blueprint.repository.reviewedCommit ?? "No exact reviewed SHA is available; inspect HEAD and report the SHA before editing."}\nExisting stack:\n${bullets(blueprint.repository.existingStack, "Detect from repository files before changing architecture.")}\nRelevant files:\n${bullets(blueprint.repository.relevantFiles.slice(0, 30), "Inspect the bounded relevant area before editing.")}`] : []),
    ...(input.reviewFindings?.length ? ["", "## Review Findings to Correct", bullets(input.reviewFindings)] : []),
    "", `## ${stack.some((item) => item.status === "confirmed") ? "Confirmed and Recommended Technology Stack" : "Recommended Technology Stack"}`, stack.map((item) => `### ${item.purpose}\nTechnology: ${item.technology}\nStatus: ${item.status === "confirmed" ? "User confirmed" : item.status === "existing" ? "Existing repository technology" : "Promgent recommendation"}\nWhy: ${item.rationale}`).join("\n\n"),
    ...(input.promptPlan?.stackRationale.length ? ["", "Additional stack reasoning:", bullets(input.promptPlan.stackRationale)] : []),
    "", "## System Architecture", blueprint.architecture.summary, "", "```mermaid", blueprint.architecture.mermaid, "```",
    "", "## Component Responsibilities", [blueprint.systemComponents.map((item) => `### ${item.name}${item.technology ? ` — ${item.technology}` : ""}\n${item.responsibility}`).join("\n\n"), ...(input.promptPlan?.componentResponsibilities.length ? [`\nProject-specific refinements:\n${bullets(input.promptPlan.componentResponsibilities)}`] : [])].join("\n"),
    "", "## User Roles and Authorization", bullets(roles),
    "", "## Pages and Screens", [blueprint.pages.map((page) => `### ${page.name} (${page.route})\nPurpose: ${page.purpose}\nVisible content:\n${bullets(page.visibleContent)}\nKey actions:\n${bullets(page.actions)}\nData needed:\n${bullets(page.dataNeeded)}`).join("\n\n"), ...(input.promptPlan?.pages.length ? [`\nAdditional project-specific page behavior:\n${bullets(input.promptPlan.pages)}`] : [])].join("\n"),
    "", "## User Workflows", [blueprint.workflows.map((workflow) => `### ${workflow.name}\nActor: ${workflow.actor}\n${numbered(workflow.steps)}\n\nFailure behavior:\n${bullets(workflow.failureBehavior)}`).join("\n\n"), ...(input.promptPlan?.workflows.length ? [`\nAdditional workflow detail:\n${bullets(input.promptPlan.workflows)}`] : [])].join("\n"),
    "", "## Application Behavior and UX States", bullets(["Show a stable loading state without clearing existing useful content.", "Validate fields inline and again on the server.", "Show an explicit success state only after the server confirms persistence.", "Show useful empty states with the next available action.", "Return safe, actionable errors and preserve retryable input.", "On unauthorized access, reveal no protected data and direct the user to authenticate or an allowed screen.", "Support keyboard use, visible focus, semantic labels, and mobile layouts without horizontal page overflow."]),
    "", "## Data Model", blueprint.dataEntities.length ? blueprint.dataEntities.map((entity) => `### ${entity.name}\nPurpose: ${entity.purpose}\nFields:\n${entity.fields.map((field) => `- ${field.name}: ${field.type}${field.required ? " (required)" : " (optional)"}${field.constraints.length ? ` — ${field.constraints.join("; ")}` : ""}`).join("\n")}\nRelationships:\n${bullets(entity.relationships)}\nConstraints:\n${bullets(entity.constraints)}`).join("\n\n") : "No persistent entities are currently required. Do not add a database without a demonstrated need.",
    "", "## API and Server Operations", [blueprint.apiSurface.length ? blueprint.apiSurface.map((api) => `### ${api.name}${api.path ? ` — ${api.method} ${api.path}` : ` — ${api.method}`}\nAuthentication: ${api.authentication}\nRequest data:\n${bullets(api.request)}\nValidation:\n${bullets(api.validation)}\nResponse behavior: ${api.response}`).join("\n\n") : "Keep trusted mutations on the server and derive concrete operation names from the established repository conventions.", ...(input.promptPlan?.apiOperations.length ? [`\nProject-specific operations:\n${bullets(input.promptPlan.apiOperations)}`] : [])].join("\n"),
    "", "## Authentication", blueprint.recommendedStack.authentication ? `${blueprint.recommendedStack.authentication.technology}: ${blueprint.recommendedStack.authentication.rationale} Sessions must be restored safely, expire predictably, and protect server operations as well as pages.` : "No end-user authentication is required by current scope. Do not add it unless a protected workflow requires it.",
    "", "## Authorization", bullets(roles.length ? roles : ["Public users may access only public content and operations."]),
    "", "## Security", [blueprint.security.map((item) => `- ${item.area}: ${item.behavior} Why: ${item.rationale}`).join("\n"), ...(input.promptPlan?.securityConsiderations.length ? [bullets(input.promptPlan.securityConsiderations)] : [])].join("\n"),
    "", "## Integrations", blueprint.integrations.length ? blueprint.integrations.map((item) => `- ${item.name}: ${item.purpose} Direction: ${item.direction}. Failure behavior: ${item.failureBehavior}`).join("\n") : "- No external integration is required by current scope.",
    "", "## Design, Responsive, and Accessibility Requirements", bullets([...input.memory.designPreferences, "Use the existing visual language and design tokens when a repository exists.", "Design mobile-first and verify phone, tablet, and desktop layouts.", "Meet WCAG-oriented semantics, contrast, keyboard access, labels, and focus behavior."]),
    "", "## Implementation Phases", [blueprint.implementationPhases.map((phase) => `### ${phase.name}\nObjective: ${phase.objective}\nDeliverables:\n${bullets(phase.deliverables)}\nDependencies:\n${bullets(phase.dependsOn, "None")}`).join("\n\n"), ...(input.promptPlan?.implementationPhases.length ? [`\nProject-specific phase considerations:\n${bullets(input.promptPlan.implementationPhases)}`] : [])].join("\n"),
    "", "## Testing Requirements", `Unit:\n${bullets(blueprint.testingStrategy.unit)}\n\nIntegration:\n${bullets(blueprint.testingStrategy.integration)}\n\nEnd-to-end:\n${bullets(blueprint.testingStrategy.endToEnd)}\n\nRegression:\n${bullets([...blueprint.testingStrategy.regression, ...(input.promptPlan?.testingScenarios ?? [])])}`,
    "", "## Database and Migration Requirements", blueprint.dataEntities.length ? "Create additive, reversible migrations for the listed entities and constraints. Preserve existing records, apply row-level or server authorization policies where applicable, and verify both forward migration and application compatibility." : "No database migration is required unless repository inspection proves persistence is needed.",
    "", "## Environment Variables", bullets(blueprint.deploymentPlan.environmentVariables.map((name) => `${name} — variable name/purpose only; never place secret values in source, prompts, logs, or client output.`), "No new environment variables identified."),
    "", "## Deployment", `Platform: ${blueprint.deploymentPlan.platform}\n\nSteps:\n${numbered(blueprint.deploymentPlan.steps)}\n\nRelease checks:\n${bullets(blueprint.deploymentPlan.releaseChecks)}`,
    "", "## Acceptance Criteria", bullets(blueprint.acceptanceCriteria, "Translate each MVP requirement into an observable criterion before claiming completion."),
    "", "## Constraints and Assumptions", `Constraints:\n${bullets([...new Set([...(input.memory.constraints ?? []), ...input.memory.technicalConstraints])])}\n\nAssumptions:\n${bullets(blueprint.assumptions)}`,
    "", "## Do Not Change", bullets([...blueprint.excludedScope, ...(blueprint.repository ? ["Do not replace the established framework, authentication, persistence, or deployment approach without a documented incompatibility.", "Do not rewrite unrelated working areas."] : [])], "Do not add unrequested scope or unrelated infrastructure."),
    "", "## Verification", bullets(verificationCommands(blueprint)), "Verify the complete persisted user journey in a fresh browser session where state changes are involved. Do not claim a check passed unless it was actually executed.",
    "", "## Final Implementation Report", bullets(["Files changed and why", "User-visible and system behavior delivered", "Database migrations and how to apply them", "Environment-variable names or deployment changes", "Tests and commands actually executed with results", "Remaining limitations, risks, or follow-up work"]),
  ].join("\n");
  return result(input, depth, content);
}

const FULL_SECTIONS = ["Role", "Objective", "MVP Scope", "Technology Stack", "System Architecture", "User Workflows", "Data Model", "Security", "Implementation Phases", "Testing Requirements", "Acceptance Criteria", "Verification", "Final Implementation Report"];
export function validateCompiledPrompt(content: string, depth: PromptDepth): { valid: boolean; warnings: string[] } {
  if (depth !== "full_mvp" && depth !== "major_feature" && depth !== "repository_correction" && depth !== "refactor") return { valid: content.includes("## Objective") && content.includes("## Verification"), warnings: [] };
  const warnings = FULL_SECTIONS.filter((section) => section === "Technology Stack" ? !content.includes("Technology Stack") : !content.includes(`## ${section}`)).map((section) => `Missing expected section: ${section}`);
  if (!/```mermaid[\s\S]+```/.test(content)) warnings.push("Missing architecture Mermaid diagram.");
  return { valid: warnings.length === 0, warnings };
}
