import type { PlanRequest } from "@/lib/planner";
import type { PlanningDepth, ProjectMemory, ProjectRecord, SrsDocument } from "@/types/project";

/** Converts an approved Guided Project handoff into the existing planner contract. */
export function planningRequestFromApprovedSrs(input: {
  project: ProjectRecord;
  memory: ProjectMemory;
  srs: SrsDocument;
  optimization?: PlanningDepth;
}): PlanRequest {
  if (input.srs.status !== "approved") {
    throw new Error("Only an approved SRS can enter implementation planning.");
  }
  return {
    taskDescription: [input.project.initialDescription, "\nAPPROVED SOFTWARE REQUIREMENTS SPECIFICATION:", input.srs.content].join("\n"),
    modelId: input.project.selectedModel,
    optimization: input.optimization === "fast" ? "minimize-cost" : input.optimization === "thorough" ? "maximum-quality" : "balanced",
    budget: input.project.creditBudget,
    clarifyingQuestions: [],
    clarifyingResponses: {},
  };
}
