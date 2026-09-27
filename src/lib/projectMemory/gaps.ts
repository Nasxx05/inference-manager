import type { ProjectMemory, RequirementArea } from "@/types/project";

export interface RequirementGap {
  area: RequirementArea;
  label: string;
  question: string;
  critical: boolean;
}

const BASE_GAPS: Array<{ area: RequirementArea; label: string; question: string; critical: boolean }> = [
  { area: "users", label: "Users and audience", question: "Who will use this, and what should each type of user be able to do?", critical: true },
  { area: "core_functionality", label: "Core functionality", question: "What is the most important outcome the product must deliver?", critical: true },
  { area: "workflows", label: "Main workflow", question: "What should happen from the user's first step through the successful outcome?", critical: true },
  { area: "data", label: "Data", question: "What information must the product store, display, or transform?", critical: false },
  { area: "interfaces", label: "Interface and design", question: "What should the experience look and feel like, and are there references to follow?", critical: false },
  { area: "security", label: "Security and access", question: "What needs to be private, protected, or restricted to particular users?", critical: false },
  { area: "deployment", label: "Delivery", question: "Where should this run, and are there deployment or operational constraints?", critical: false },
  { area: "acceptance_criteria", label: "Success criteria", question: "How will you know the first version is complete and working?", critical: true },
];

export function detectRequirementGaps(memory: Pick<ProjectMemory, "requirements">): RequirementGap[] {
  const activeAreas = new Set(
    memory.requirements
      .filter((item) => item.status !== "rejected" && item.status !== "superseded")
      .map((item) => item.category),
  );

  return BASE_GAPS.filter((gap) => !activeAreas.has(gap.area));
}
