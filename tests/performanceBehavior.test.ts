import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { buildProjectContext, __contextLimits } from "@/lib/projectMemory/context";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";
import { loadInterviewStateForUser } from "../server/src/persistence";
import { runOrbioInference } from "../server/src/orbioInference";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("performance behavior", () => {
  it("marks a stored connection invalid when the real inference returns 401/403", async () => {
    const markInvalid = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ apiKey: "plain-key", fingerprint: "fingerprint" }));

    await expect(runOrbioInference(
      "user-1",
      async () => { throw new AiError("AI_AUTH_FAILED", "rejected", { status: 401 }); },
      undefined,
      { load, markInvalid },
    )).rejects.toMatchObject({ code: "ORBIO_KEY_EXPIRED_OR_INVALID" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(markInvalid).toHaveBeenCalledOnce();
  });

  it("does not mark a connection invalid for non-auth provider failures", async () => {
    const markInvalid = vi.fn(async () => undefined);
    await expect(runOrbioInference(
      "user-1",
      async () => { throw new AiError("AI_RATE_LIMITED", "limited", { status: 429 }); },
      { apiKey: "plain-key", fingerprint: "fingerprint" },
      { load: vi.fn(), markInvalid },
    )).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
    expect(markInvalid).not.toHaveBeenCalled();
  });

  it("loads interview state without SRS, repository, history, messages, references, or usage queries", async () => {
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    const project = createProjectRecord({ id: "project-1", userId: "user-1", description: "Build a booking app", modelId: "gpt-4o", planningDepth: "balanced", budget: 10, now: "2026-01-01T00:00:00.000Z" });
    const memory = createInitialMemory(project, project.createdAt);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/projects?")) return Response.json([{ id: project.id, user_id: project.userId, title: project.title, initial_description: project.initialDescription, project_type: project.projectType, selected_model: project.selectedModel, planning_depth: project.planningDepth, credit_budget: project.creditBudget, status: project.status, created_at: project.createdAt, updated_at: project.updatedAt }]);
      if (url.includes("/project_memory?")) return Response.json([{ memory }]);
      if (url.includes("/interview_sessions?")) return Response.json([{ id: "session-1", project_id: project.id, planning_depth: "balanced", status: "active", turn_count: 0, created_at: project.createdAt, updated_at: project.updatedAt }]);
      return Response.json([]);
    }));

    const state = await loadInterviewStateForUser(project.id, project.userId);
    expect(state.project.id).toBe(project.id);
    expect(urls).toHaveLength(3);
    expect(urls.join(" ")).not.toMatch(/srs_documents|architecture_versions|project_iterations|interview_messages|project_references|generated_prompts|usage_events/);
  });

  it("bounds model context deterministically without mutating canonical memory", () => {
    const project = createProjectRecord({ id: "project-context", userId: "user-1", description: "Build an app", modelId: "gpt-4o", planningDepth: "thorough", budget: 10, now: "2026-01-01T00:00:00.000Z" });
    const memory = createInitialMemory(project, project.createdAt);
    const template = memory.requirements[0];
    memory.requirements = Array.from({ length: 100 }, (_, index) => ({
      ...template,
      id: `requirement-${String(index).padStart(3, "0")}`,
      description: `Requirement number ${index}`,
      status: index < 70 ? "confirmed" as const : "proposed" as const,
      priority: index % 4 === 0 ? "critical" as const : "medium" as const,
    }));
    const originalCount = memory.requirements.length;

    const first = buildProjectContext(memory, "Current response");
    const second = buildProjectContext(memory, "Current response");
    const included = first.split("\n").filter((line) => line.startsWith("- ["));
    expect(first).toBe(second);
    expect(included.length).toBeLessThanOrEqual(__contextLimits.confirmedRequirements + __contextLimits.proposedRequirements);
    expect(memory.requirements).toHaveLength(originalCount);
  });

  it("runs independent persistence operations concurrently", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = (name: string) => async () => { order.push(`start:${name}`); await gate; order.push(`end:${name}`); };
    const pending = Promise.all([
      operation("memory")(),
      (async () => { await operation("requirements")(); await operation("criteria")(); })(),
      operation("session")(),
    ]);
    await Promise.resolve();
    expect(order).toEqual(["start:memory", "start:requirements", "start:session"]);
    release();
    await pending;
    expect(order.indexOf("start:criteria")).toBeGreaterThan(order.indexOf("end:requirements"));
  });
});
