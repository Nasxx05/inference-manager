import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import type {
  PlanningDepth,
  ProjectMemory,
  ProjectRecord,
  Requirement,
} from "@/types/project";
import { calculateCompleteness } from "./completeness";
import { refreshQuestionBacklog } from "./backlog";
import { createRequirement } from "./requirements";
import { splitAtomicRequirements } from "./proposals";

function titleFromDescription(description: string): string {
  const clean = description.trim().replace(/\s+/g, " ");
  if (!clean) return "Untitled project";
  return clean.length > 72 ? `${clean.slice(0, 69).trimEnd()}...` : clean;
}

function initialRequirements(project: ProjectRecord): Requirement[] {
  const analysis = heuristicAnalyze(project.initialDescription);
  const requirements = [
    createRequirement({
      projectId: project.id,
      description: project.initialDescription,
      category: "core_functionality",
      type: "business",
      priority: "critical",
      source: "user",
      status: "confirmed",
      confidence: "high",
    }),
    ...splitAtomicRequirements(project.initialDescription).filter((description) => description !== project.initialDescription.trim()).map((description) =>
      createRequirement({
        projectId: project.id,
        description,
        category: "core_functionality",
        type: "functional",
        priority: "high",
        source: "user",
        status: "confirmed",
        confidence: "high",
      }),
    ),
    ...analysis.phases.slice(0, 4).map((phase) =>
      createRequirement({
        projectId: project.id,
        description: phase.description,
        category: phase.name.toLowerCase().includes("design") ? "interfaces" : "core_functionality",
        priority: phase.priority === "essential" ? "high" : "medium",
        source: "system",
        status: "proposed",
        confidence: "medium",
      }),
    ),
  ];

  const seen = new Set<string>();
  return requirements.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function createInitialMemory(project: ProjectRecord, now = new Date().toISOString()): ProjectMemory {
  const requirements = initialRequirements(project);
  const base: Omit<ProjectMemory, "completeness" | "openQuestions"> & { openQuestions: [] } = {
    projectId: project.id,
    purpose: project.initialDescription.trim(),
    projectType: project.projectType,
    users: [],
    requirements,
    conflicts: [],
    assumptions: [],
    risks: [],
    openQuestions: [],
    designPreferences: [],
    technicalConstraints: [],
    acceptanceCriteria: [],
    version: 1,
    updatedAt: now,
  };

  const memory = {
    ...base,
    completeness: calculateCompleteness(base, project.planningDepth),
  } as ProjectMemory;
  memory.openQuestions = refreshQuestionBacklog(memory);
  return memory;
}

export function createProjectRecord(input: {
  userId: string;
  description: string;
  modelId: string;
  planningDepth: PlanningDepth;
  budget: number;
  projectType?: string;
  id?: string;
  now?: string;
}): ProjectRecord {
  const now = input.now ?? new Date().toISOString();
  return {
    // The persistence adapter supplies a UUID for database-backed projects.
    // The readable fallback keeps the pure helper useful in local tests.
    id: input.id ?? `project_${Date.now().toString(36)}`,
    userId: input.userId,
    title: titleFromDescription(input.description),
    initialDescription: input.description.trim(),
    projectType: input.projectType ?? heuristicAnalyze(input.description).taskType,
    selectedModel: input.modelId,
    planningDepth: input.planningDepth,
    creditBudget: input.budget,
    status: "intake",
    createdAt: now,
    updatedAt: now,
  };
}
