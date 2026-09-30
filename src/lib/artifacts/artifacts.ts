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
