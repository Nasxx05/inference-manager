import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";
import { canRenderProjectMode, canReviewImplementation, resolveProjectWorkspaceMode, safeProjectReturnMode } from "@/lib/projectLifecycle";
import { persistInterviewTurnAtomic, PersistenceError } from "../server/src/persistence";
import type { GuidedProjectSnapshot, InterviewMessage, InterviewSession } from "@/types/project";

function snapshot(): GuidedProjectSnapshot {
  const project = createProjectRecord({ id: "10000000-0000-4000-8000-000000000001", userId: "10000000-0000-4000-8000-000000000002", description: "Build a booking service", modelId: "auto", planningDepth: "balanced", budget: 10, now: "2026-01-01T00:00:00.000Z" });
  const memory = createInitialMemory(project);
  return {
    project,
    memory,
    interview: { id: "10000000-0000-4000-8000-000000000003", projectId: project.id, planningDepth: "balanced", status: "active", turnCount: 0, createdAt: project.createdAt, updatedAt: project.updatedAt },
    messages: [], references: [],
    usage: { budget: 10, used: 0, remaining: 10, events: [], estimated: false, updatedAt: project.updatedAt },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("atomic interview persistence", () => {
  function configured() {
    process.env.SUPABASE_URL = "https://database.example";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  }

  function turnInput() {
    const state = snapshot();
    const session: InterviewSession = { ...state.interview, turnCount: 1 };
    const userMessage: InterviewMessage = { id: "10000000-0000-4000-8000-000000000004", projectId: state.project.id, sessionId: session.id, role: "user", content: "Need reminders", source: "text", createdAt: state.project.createdAt };
    const assistantMessage: InterviewMessage = { ...userMessage, id: "10000000-0000-4000-8000-000000000005", role: "assistant", content: "Understood", source: "system" };
    return { userId: state.project.userId, projectId: state.project.id, userMessage, assistantMessage, memory: state.memory, session };
  }

  it("submits one RPC containing both valid UUID messages and every child record", async () => {
    configured();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await persistInterviewTurnAtomic(turnInput());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rpc/persist_interview_turn");
    const body = JSON.parse(String(init.body));
    expect(body.p_user_message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.p_assistant_message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toHaveProperty("p_memory");
    expect(body).toHaveProperty("p_requirements");
    expect(body).toHaveProperty("p_acceptance_criteria");
    expect(body).toHaveProperty("p_session");
  });

  it("normalizes a failed child write as one rollback-safe error", async () => {
    configured();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "private database constraint detail" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await persistInterviewTurnAtomic(turnInput()).catch((caught) => caught);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error.code).toBe("INTERVIEW_PERSISTENCE_FAILED");
    expect(error.message).not.toContain("constraint detail");
  });

  it("defines all turn writes in the same PostgreSQL function", () => {
    const sql = readFileSync("server/migrations/005_reliability_repairs.sql", "utf8");
    expect(sql).toContain("insert into public.interview_messages");
    expect(sql).toContain("insert into public.project_memory");
    expect(sql).toContain("insert into public.requirements");
    expect(sql).toContain("insert into public.acceptance_criteria");
    expect(sql).toContain("update public.interview_sessions");
    expect(sql).toContain("raise exception 'interview session update failed'");
  });
});

describe("canonical lifecycle resolution", () => {
  it("opens each project at its latest valid persisted stage", () => {
    const base = snapshot();
    expect(resolveProjectWorkspaceMode(base)).toBe("interview");
    const architecture = { id: `architecture_${base.project.id}_1`, projectId: base.project.id, version: 1, diagramSource: "flowchart TD\nUser --> Application", summary: "summary", reasonForChange: "initial", createdAt: base.project.createdAt };
    expect(resolveProjectWorkspaceMode({ ...base, architecture })).toBe("architecture");
    const srs = { id: `srs_${base.project.id}_1`, projectId: base.project.id, version: 1, title: "SRS", content: "draft", requirementIds: [], status: "draft" as const, createdAt: base.project.createdAt };
    expect(resolveProjectWorkspaceMode({ ...base, architecture, srs })).toBe("srs");
    const implementationPlan = { id: "plan", prompt: "Implement", createdAt: base.project.createdAt } as GuidedProjectSnapshot["implementationPlan"];
    expect(resolveProjectWorkspaceMode({ ...base, architecture, srs, implementationPlan })).toBe("implementation");
    expect(resolveProjectWorkspaceMode({ ...base, project: { ...base.project, status: "iterating" }, architecture, srs, implementationPlan })).toBe("iteration");
    expect(safeProjectReturnMode({ snapshot: { ...base, implementationPlan } })).toBe("implementation");
  });

  it("never permits review or an implementation return without a plan", () => {
    const base = snapshot();
    expect(canReviewImplementation(base)).toBe(false);
    expect(safeProjectReturnMode({ snapshot: base })).toBe("interview");
    expect(canRenderProjectMode({ mode: "implementation", snapshot: base })).toBe(false);
    expect(canRenderProjectMode({ mode: "iteration", snapshot: base })).toBe(false);
  });

  it("gives every invalid project mode a deterministic recoverable stage", () => {
    const base = snapshot();
    for (const mode of ["architecture", "srs", "implementation", "iteration"] as const) {
      expect(canRenderProjectMode({ mode, snapshot: base })).toBe(false);
      expect(safeProjectReturnMode({ snapshot: base })).toBe("interview");
    }
  });
});

describe("persisted ID schema contract", () => {
  it("keeps interview messages UUID while domain version IDs remain text", () => {
    const schema = readFileSync("server/migrations/001_guided_projects.sql", "utf8");
    expect(schema).toMatch(/create table if not exists public\.interview_messages[\s\S]*?id uuid primary key/);
    expect(schema).toMatch(/create table if not exists public\.architecture_versions[\s\S]*?id text primary key/);
    expect(schema).toMatch(/create table if not exists public\.srs_documents[\s\S]*?id text primary key/);
  });

  it("keeps opening messages on the server UUID generator and server approval gated", () => {
    const routes = readFileSync("server/src/guidedRoutes.ts", "utf8");
    expect(routes).toMatch(/const assistantMessage = \{\s*id: randomUUID\(\)/);
    expect(routes).toContain('memory.completeness.level !== "ready"');
    expect(routes).toContain('"SPECIFICATION_INCOMPLETE"');
  });
});
