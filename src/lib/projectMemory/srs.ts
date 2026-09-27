import type { ArchitectureVersion, ProjectMemory, Requirement, SrsDocument } from "@/types/project";
import { activeRequirements } from "./requirements";
import { structuredAcceptanceCriteria } from "./proposals";

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim() || "Not yet specified."}\n`;
}

function requirementsByType(requirements: Requirement[], type: Requirement["type"], memory: ProjectMemory): string {
  const matching = requirements.filter((item) => item.type === type);
  const criteria = structuredAcceptanceCriteria(memory);
  return matching.length
    ? matching.map((item) => {
      const linked = criteria.filter((criterion) => criterion.requirementId === item.id && criterion.status !== "rejected" && criterion.status !== "superseded");
      return [`- **${item.id}** (${item.status}, ${item.priority}): ${item.description}`, ...linked.map((criterion) => `  - **${criterion.id}** [${criterion.status}]: ${criterion.description}`)].join("\n");
    }).join("\n")
    : "Not yet specified.";
}

export function generateSrs(input: {
  memory: ProjectMemory;
  architecture?: ArchitectureVersion;
  version?: number;
  now?: string;
}): SrsDocument {
  const requirements = activeRequirements(input.memory);
  const version = input.version ?? 1;
  const content = [
    `# Software Requirements Specification: ${input.memory.purpose || "Project"}`,
    "",
    section("1. Introduction", `Purpose: ${input.memory.purpose}\n\nProject type: ${input.memory.projectType}`),
    section("2. Users and Overall Description", input.memory.users.join("\n") || "User groups are still being clarified."),
    section("3. Functional Requirements", requirementsByType(requirements, "functional", input.memory)),
    section("4. Business Requirements", requirementsByType(requirements, "business", input.memory)),
    section("5. Non-Functional Requirements", requirementsByType(requirements, "non_functional", input.memory)),
    section("6. Data and Integration Requirements", `${requirementsByType(requirements, "data", input.memory)}\n\n${requirementsByType(requirements, "integration", input.memory)}`),
    section("7. Security Requirements", requirementsByType(requirements, "security", input.memory)),
    section("8. Design and UX Requirements", `${requirementsByType(requirements, "design", input.memory)}\n\nPreferences:\n${input.memory.designPreferences.map((item) => `- ${item}`).join("\n")}`),
    section("9. Architecture", input.architecture?.summary ?? "Architecture has not been approved yet."),
    section("10. Acceptance Criteria", structuredAcceptanceCriteria(input.memory).map((item) => `- **${item.id}** → ${item.requirementId} [${item.status}]: ${item.description}`).join("\n")),
    section("11. Assumptions, Risks and Open Issues", `Assumptions:\n${input.memory.assumptions.map((item) => `- ${item}`).join("\n")}\n\nRisks:\n${input.memory.risks.map((item) => `- ${item}`).join("\n")}\n\nOpen issues:\n${input.memory.completeness.criticalGaps.map((item) => `- ${item}`).join("\n")}`),
  ].join("\n");

  return {
    id: `srs_${input.memory.projectId}_${version}`,
    projectId: input.memory.projectId,
    version,
    title: `Software Requirements Specification: ${input.memory.purpose || "Project"}`,
    content,
    requirementIds: requirements.map((item) => item.id),
    status: "draft",
    createdAt: input.now ?? new Date().toISOString(),
  };
}
