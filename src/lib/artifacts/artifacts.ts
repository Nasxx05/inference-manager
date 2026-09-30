import type { ArtifactType, ProjectArtifact } from "@/types/conversation";
import type { ArchitectureVersion, ProjectMemory } from "@/types/project";
import { activeRequirements } from "@/lib/projectMemory/requirements";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function artifactEquivalent(left: Pick<ProjectArtifact, "content" | "structuredData">, right: Pick<ProjectArtifact, "content" | "structuredData">): boolean {
  return left.content.trim() === right.content.trim() && stable(left.structuredData) === stable(right.structuredData);
}

export function buildArtifact(input: {
  id: string;
  projectId: string;
  type: ArtifactType;
  title: string;
  content: string;
  structuredData?: Record<string, unknown>;
  sourceMessageId?: string;
  previous?: ProjectArtifact;
  now?: string;
}): ProjectArtifact {
  const now = input.now ?? new Date().toISOString();
  const candidate = { content: input.content.trim(), structuredData: input.structuredData ?? {} };
  if (input.previous && artifactEquivalent(input.previous, candidate)) return input.previous;
  return {
    id: input.id, projectId: input.projectId, type: input.type,
    version: (input.previous?.version ?? 0) + 1, title: input.title.trim(),
    ...candidate, ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.previous ? { supersedesArtifactId: input.previous.id } : {}),
    status: "current", createdAt: now, updatedAt: now,
  };
}

export function projectBlueprint(memory: ProjectMemory): { title: string; content: string; structuredData: Record<string, unknown> } {
  const requirements = activeRequirements(memory);
  const core = requirements.filter((item) => item.required).slice(0, 16);
  const stack = memory.confirmedStack?.length ? memory.confirmedStack : memory.proposedStack ?? [];
  const sections = [
    `# Project Blueprint: ${memory.purpose || "Untitled project"}`,
    `\n## What we are building\n${memory.purpose || "Still being defined."}`,
    `\n## Who it is for\n${memory.users.length ? memory.users.map((item) => `- ${item}`).join("\n") : "- Primary users are still being clarified."}`,
    `\n## Core first-version features\n${core.length ? core.map((item) => `- ${item.description}`).join("\n") : "- The first-version scope is still being shaped."}`,
    `\n## Recommended technology\n${stack.length ? stack.map((item) => `- ${item}`).join("\n") : "- Promgent will recommend the simplest adequate stack after the key workflow is clear."}`,
    `\n## Main user flows\n${memory.workflows?.length ? memory.workflows.map((item) => `- ${item}`).join("\n") : "- Main flows are still being clarified."}`,
    `\n## Deliberately left out\n${memory.deferredScope?.length ? memory.deferredScope.map((item) => `- ${item}`).join("\n") : "- Nothing recorded yet."}`,
    `\n## Definition of done\n${memory.acceptanceCriteria.length ? memory.acceptanceCriteria.slice(0, 20).map((item) => `- ${typeof item === "string" ? item : item.description}`).join("\n") : "- Acceptance criteria are still being shaped."}`,
  ];
  return { title: "Project Blueprint", content: sections.join("\n"), structuredData: { requirementIds: core.map((item) => item.id), phase: memory.projectPhase ?? "exploring" } };
}

export function architectureArtifact(architecture: ArchitectureVersion): { title: string; content: string; structuredData: Record<string, unknown> } {
  return { title: "Architecture", content: `${architecture.summary}\n\n\`\`\`mermaid\n${architecture.diagramSource}\n\`\`\``, structuredData: { diagramSource: architecture.diagramSource, reasonForChange: architecture.reasonForChange, legacyArchitectureId: architecture.id } };
}

export function implementationPromptArtifact(input: {
  memory: ProjectMemory;
  title?: string;
  additionalInstructions?: string;
  kind?: "implementation" | "correction" | "enhancement";
}): { title: string; content: string; structuredData: Record<string, unknown> } {
  const { memory } = input;
  const requirements = activeRequirements(memory).filter((item) => item.required).slice(0, 30);
  const criteria = memory.acceptanceCriteria
    .map((item) => typeof item === "string" ? item : item.description)
    .filter(Boolean)
    .slice(0, 40);
  const stack = memory.confirmedStack?.length ? memory.confirmedStack : memory.proposedStack ?? [];
  const list = (items: string[], empty: string) => items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
  const kind = input.kind ?? "implementation";
  const title = input.title?.trim() || `${kind[0]!.toUpperCase()}${kind.slice(1)} prompt`;
  const content = [
    `# ${title}`,
    "",
    "## Role",
    "Act as a senior product engineer working inside the existing repository. Inspect the current implementation before editing, preserve working behavior, and make the smallest coherent change that fully satisfies this prompt.",
    "",
    "## Objective",
    memory.purpose || "Implement the confirmed project scope described below.",
    "",
    "## Current project context",
    `- Project phase: ${memory.projectPhase ?? "exploring"}`,
    `- Current implementation: ${memory.currentImplementationState ?? "Inspect the repository and report what already exists before changing it."}`,
    `- Reviewed commit: ${memory.currentReviewedCommit ?? "No reviewed commit is recorded; do not assume repository state."}`,
    "",
    "## Required scope",
    list(requirements.map((item) => `[${item.priority}] ${item.description}`), "No requirements are confirmed yet; stop and request the missing product decisions."),
    "",
    "## Main workflows",
    list(memory.workflows ?? [], "Derive only the minimum workflows supported by the required scope."),
    "",
    "## Technical direction",
    list(stack, "Reuse the repository's established stack and conventions; do not introduce a new framework without a demonstrated need."),
    "",
    "## Constraints",
    list([...new Set([...(memory.constraints ?? []), ...memory.technicalConstraints])], "Preserve backward compatibility, security boundaries, and existing user data."),
    "",
    "## Acceptance criteria",
    list(criteria, "Add observable acceptance criteria before implementation if the requested behavior remains ambiguous."),
    "",
    "## Additional task-specific instructions",
    input.additionalInstructions?.trim() || "No additional instructions. Follow the canonical scope above.",
    "",
    "## Implementation requirements",
    "- Trace each code change to a required behavior or acceptance criterion.",
    "- Reuse existing modules, design tokens, data contracts, and error-handling patterns.",
    "- Keep authentication, authorization, persistence, and transaction boundaries intact.",
    "- Handle loading, empty, success, validation, and failure states where the affected flow needs them.",
    "- Do not silently add product scope, dependencies, migrations, or infrastructure that the requirements do not justify.",
    "- If a database change is required, provide a safe forward migration and maintain compatibility with existing records.",
    "",
    "## Verification",
    "- Run the relevant unit, integration, type, lint, and production-build checks.",
    "- Add or update regression tests for every changed behavior and important failure path.",
    "- Verify the complete user journey, including persistence after refresh when state changes.",
    "- Never claim a check passed unless it was actually executed; report any unavailable check explicitly.",
    "",
    "## Do not change",
    list(memory.deferredScope ?? [], "Anything outside the required scope or unrelated working behavior."),
    "",
    "## Final report",
    "Return a concise summary of files changed, product behavior delivered, migrations or configuration required, tests executed with results, and any remaining risks or follow-up work.",
  ].join("\n");
  return {
    title,
    content,
    structuredData: {
      kind,
      requirementIds: requirements.map((item) => item.id),
      acceptanceCriteriaCount: criteria.length,
      generatedFromMemoryVersion: memory.version,
    },
  };
}
