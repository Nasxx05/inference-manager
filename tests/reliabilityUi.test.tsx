/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArchitectureCard, SrsCard } from "@/components/GuidedProjectWorkspace";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";
import type { GuidedProjectSnapshot } from "@/types/project";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 720 320"><text>Application</text><text>Database</text></svg>' })),
  },
}));

function incompleteSnapshot(): GuidedProjectSnapshot {
  const project = createProjectRecord({ id: "20000000-0000-4000-8000-000000000001", userId: "20000000-0000-4000-8000-000000000002", description: "Build an app", modelId: "auto", planningDepth: "thorough", budget: 10, now: "2026-01-01T00:00:00.000Z" });
  const memory = createInitialMemory(project);
  return { project, memory, interview: { id: "20000000-0000-4000-8000-000000000003", projectId: project.id, planningDepth: "thorough", status: "active", turnCount: 0, createdAt: project.createdAt, updatedAt: project.updatedAt }, messages: [], references: [], usage: { budget: 10, used: 0, remaining: 10, events: [], estimated: false, updatedAt: project.updatedAt } };
}

describe("reliability UI", () => {
  it("renders architecture metadata and a safe visible diagram", async () => {
    render(<ArchitectureCard architecture={{ id: "architecture_project_1", projectId: "project", version: 1, diagramSource: "flowchart TD\nUser --> Application\nApplication --> Database", summary: "Application with persistence.", reasonForChange: "Initial architecture.", createdAt: "2026-01-01T00:00:00.000Z" }} projectTitle="Booking" busy={false} onBack={vi.fn()} onSrs={vi.fn()} error={null} />);
    expect(await screen.findByRole("img", { name: /architecture diagram showing/i })).toBeInTheDocument();
    expect(await screen.findByText("Database")).toBeInTheDocument();
    expect(screen.getByText("Application with persistence.")).toBeInTheDocument();
  });

  it("shows critical gaps and disables approval for an incomplete draft", () => {
    const snapshot = incompleteSnapshot();
    const srs = { id: "srs_project_1", projectId: snapshot.project.id, version: 1, title: "SRS", content: "Draft", requirementIds: [], status: "draft" as const, createdAt: snapshot.project.createdAt };
    render(<SrsCard snapshot={snapshot} srs={srs} busy={false} onBack={vi.fn()} onApprove={vi.fn()} onPlan={vi.fn()} error={null} />);
    expect(screen.getByText(/cannot be approved yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve specification" })).toBeDisabled();
  });
});
