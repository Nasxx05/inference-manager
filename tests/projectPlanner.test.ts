import { describe, expect, it } from "vitest";
import { planningRequestFromApprovedSrs } from "@/lib/projectMemory/plannerAdapter";
import type { ProjectMemory, ProjectRecord, SrsDocument } from "@/types/project";

describe("project planning handoff", () => {
  it("keeps the same project model and CREDIT budget when entering the existing planner", () => {
    const project = {
      id: "project-1",
      userId: "user-1",
      title: "Restaurant website",
      initialDescription: "Build a restaurant website with ordering and reservations.",
      projectType: "web-development",
      selectedModel: "claude-sonnet",
      planningDepth: "balanced",
      creditBudget: 20,
      status: "approved",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ProjectRecord;
    const memory = { projectId: project.id } as ProjectMemory;
    const srs = {
      id: "srs-1",
      projectId: project.id,
      version: 1,
      title: project.title,
      content: "Approved requirements",
      requirementIds: [],
      status: "approved",
      createdAt: project.createdAt,
    } satisfies SrsDocument;

    const request = planningRequestFromApprovedSrs({ project, memory, srs });

    expect(request.modelId).toBe(project.selectedModel);
    expect(request.budget).toBe(project.creditBudget);
    expect(request.taskDescription).toContain(srs.content);
  });
});
