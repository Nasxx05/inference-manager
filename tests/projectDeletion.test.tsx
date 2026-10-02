// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProjectRecord } from "@/lib/projectMemory";

const mocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  getSession: vi.fn(),
  getOrbioStatus: vi.fn(),
  listProjects: vi.fn(),
  loadProject: vi.fn(),
}));

vi.mock("@/lib/guidedApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/guidedApi")>()),
  deleteProject: mocks.deleteProject,
  getSession: mocks.getSession,
  getOrbioStatus: mocks.getOrbioStatus,
  listProjects: mocks.listProjects,
  loadProject: mocks.loadProject,
}));

import { ProjectWorkspace } from "@/components/project/ProjectWorkspace";

const project = createProjectRecord({
  id: "00000000-0000-4000-8000-000000000901",
  userId: "user-delete",
  description: "A URL shortener",
  modelId: "auto",
  planningDepth: "balanced",
  budget: 2,
  now: "2026-10-02T00:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.getSession.mockResolvedValue({ authenticated: true, user: { id: "user-delete", email: "user@example.com" } });
  mocks.getOrbioStatus.mockResolvedValue({ connected: false, status: "disconnected", modelIds: [], balance: null });
  mocks.listProjects.mockResolvedValue([project]);
  mocks.deleteProject.mockResolvedValue({ deleted: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("project deletion", () => {
  it("deletes a confirmed project and removes it from the sidebar", async () => {
    render(<ProjectWorkspace />);
    const button = await screen.findByRole("button", { name: `Delete ${project.title}` });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.deleteProject).toHaveBeenCalledWith(project.id));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Delete ${project.title}` })).not.toBeInTheDocument());
  }, 15_000);

  it("does not delete when confirmation is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<ProjectWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: `Delete ${project.title}` }));
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(screen.getByText(project.title)).toBeInTheDocument();
  });
});
