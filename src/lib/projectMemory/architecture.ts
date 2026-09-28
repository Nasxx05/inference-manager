import type { ArchitectureVersion, ProjectMemory } from "@/types/project";
import { activeRequirements } from "./requirements";

function has(memory: ProjectMemory, pattern: RegExp): boolean {
  return activeRequirements(memory).some((item) => pattern.test(item.description));
}

export function architectureForMemory(input: {
  memory: ProjectMemory;
  previous?: ArchitectureVersion;
  now?: string;
}): ArchitectureVersion {
  const { memory, previous } = input;
  const nodes = ["User", "Application"];
  const edges = ["User --> Application"];

  if (has(memory, /database|store|persist|history|order|booking/i)) {
    nodes.push("Database");
    edges.push("Application --> Database");
  }
  if (has(memory, /payment|checkout|billing|subscription/i)) {
    nodes.push("Payment Provider");
    edges.push("Application --> Payment Provider");
  }
  if (has(memory, /email|notification|webhook/i)) {
    nodes.push("Notification Service");
    edges.push("Application --> Notification Service");
  }
  if (has(memory, /image|upload|asset|file/i)) {
    nodes.push("File Storage");
    edges.push("Application --> File Storage");
  }

  const diagramSource = ["flowchart TD", ...edges].join("\n");
  const summary = `Users interact with the application${nodes.length > 2 ? `, which connects to ${nodes.slice(2).join(", ")}` : ""}.`;
  const changed = previous?.diagramSource !== diagramSource;
  const version = previous ? (changed ? previous.version + 1 : previous.version) : 1;

  return {
    id: `architecture_${memory.projectId}_${version}`,
    projectId: memory.projectId,
    version,
    diagramSource,
    summary,
    reasonForChange: !previous
      ? "Initial architecture derived from project memory."
      : changed
        ? "The structured project memory changed the system boundaries."
        : "The system boundaries are unchanged from the previous architecture.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}
