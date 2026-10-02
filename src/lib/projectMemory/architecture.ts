import type { ArchitectureVersion, ProjectMemory } from "@/types/project";
import { buildProductArchitecture } from "@/lib/architecture/productArchitecture";

export function architectureForMemory(input: {
  memory: ProjectMemory;
  previous?: ArchitectureVersion;
  now?: string;
}): ArchitectureVersion {
  const { memory, previous } = input;
  const productArchitecture = buildProductArchitecture({ memory });
  const diagramSource = productArchitecture.mermaid;
  const summary = productArchitecture.summary;
  const changed = previous?.diagramSource !== diagramSource;
  const version = previous ? (changed ? previous.version + 1 : previous.version) : 1;

  return {
    id: `architecture_${memory.projectId}_${version}`,
    projectId: memory.projectId,
    version,
    diagramSource,
    summary,
    reasonForChange: !previous
      ? "Initial product architecture derived from the saved project brief."
      : changed
        ? "The saved users, screens, features, data, or services changed."
        : "No diagram changes: the product structure is unchanged.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}
