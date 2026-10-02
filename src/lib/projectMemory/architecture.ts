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
  const nodes = ["User", "Client", "Application API"];
  const edges = ["User --> Client", "Client --> Application API"];

  if (has(memory, /login|sign.?in|account|role|permission|authentication|authorization/i)) {
    nodes.push("Identity Service");
    edges.push("Application API --> Identity Service");
  }

  if (has(memory, /database|store|persist|history|order|booking/i)) {
    nodes.push("Database");
    edges.push("Application API --> Database");
  }
  if (has(memory, /payment|checkout|billing|subscription/i)) {
    nodes.push("Payment Provider");
    edges.push("Application API --> Payment Provider");
  }
  if (has(memory, /email|notification|webhook/i)) {
    nodes.push("Notification Service");
    edges.push("Application API --> Notification Service");
  }
  if (has(memory, /image|upload|asset|file/i)) {
    nodes.push("File Storage");
    edges.push("Application API --> File Storage");
  }

  const boundaries = nodes.slice(3);
  const diagramSource = [`flowchart ${boundaries.length >= 3 ? "LR" : "TD"}`, ...edges].join("\n");
  const summary = `Users enter through the client, which talks to the application API${boundaries.length ? ` and its ${boundaries.join(", ")}` : ""}.`;
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
