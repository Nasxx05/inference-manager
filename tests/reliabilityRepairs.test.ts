import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";
import {
  canRenderProjectMode,
  canReviewImplementation,
  resolveProjectWorkspaceMode,
  safeProjectReturnMode,
} from "@/lib/projectLifecycle";
import {
  persistInterviewTurnAtomic,
  PersistenceError,
  refreshAuthSession,
  userForToken,
} from "../server/src/persistence";
import type {
  GuidedProjectSnapshot,
  InterviewMessage,
  InterviewSession,
} from "@/types/project";

function snapshot(): GuidedProjectSnapshot {
  const project = createProjectRecord({
    id: "10000000-0000-4000-8000-000000000001",
    userId: "10000000-0000-4000-8000-000000000002",
    description: "Build a booking service",
    modelId: "auto",
    planningDepth: "balanced",
    budget: 10,
    now: "2026-01-01T00:00:00.000Z",
  });
  const memory = createInitialMemory(project);
  return {
    project,
    memory,
    interview: {
      id: "10000000-0000-4000-8000-000000000003",
      projectId: project.id,
      planningDepth: "balanced",
      status: "active",
      turnCount: 0,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    messages: [],
    references: [],
    usage: {
      budget: 10,
      used: 0,
      remaining: 10,
      events: [],
      estimated: false,
      updatedAt: project.updatedAt,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
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
    const userMessage: InterviewMessage = {
      id: "10000000-0000-4000-8000-000000000004",
      projectId: state.project.id,
      sessionId: session.id,
      role: "user",
      content: "Need reminders",
      source: "text",
      createdAt: state.project.createdAt,
    };
    const assistantMessage: InterviewMessage = {
      ...userMessage,
      id: "10000000-0000-4000-8000-000000000005",
      role: "assistant",
      content: "Understood",
      source: "system",
    };
    return {
      userId: state.project.userId,
      projectId: state.project.id,
      userMessage,
      assistantMessage,
      memory: state.memory,
      session,
    };
  }

  it("submits one RPC containing both valid UUID messages and every child record", async () => {
    configured();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await persistInterviewTurnAtomic(turnInput());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rpc/persist_interview_turn");
    expect(init.headers).toMatchObject({
      apikey: "service",
      Authorization: "Bearer service",
    });
    const body = JSON.parse(String(init.body));
    expect(body.p_user_message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.p_assistant_message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toHaveProperty("p_memory");
    expect(body).toHaveProperty("p_requirements");
    expect(body).toHaveProperty("p_acceptance_criteria");
    expect(body).toHaveProperty("p_session");
  });

  it("normalizes a failed child write as an RPC failure", async () => {
    configured();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: "private database constraint detail" }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const error = await persistInterviewTurnAtomic(turnInput()).catch(
      (caught) => caught,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error.code).toBe("INTERVIEW_RPC_FAILED");
    expect(error.message).not.toContain("constraint detail");
  });

  it("distinguishes a missing PostgREST RPC from other persistence failures", async () => {
    configured();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              code: "PGRST202",
              message:
                "Could not find the function public.persist_interview_turn",
              details: "schema cache miss",
              hint: "reload schema",
            }),
            { status: 404 },
          ),
        ),
    );
    const error = await persistInterviewTurnAtomic({
      ...turnInput(),
      requestId: "req-persist-1",
    }).catch((caught) => caught);
    expect(error.code).toBe("INTERVIEW_RPC_NOT_FOUND");
    const logs = log.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(logs).toContain('"requestId":"req-persist-1"');
    expect(logs).toContain('"operation":"interview.persist_turn"');
    expect(logs).toContain('"httpStatus":404');
    expect(logs).toContain('"supabaseCode":"PGRST202"');
    expect(logs).toContain(`"projectId":"${turnInput().projectId}"`);
  });

  it("does not misclassify a missing dependent relation as a missing RPC", async () => {
    configured();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "42P01",
            message: 'relation "public.acceptance_criteria" does not exist',
          }),
          { status: 404 },
        ),
      ),
    );
    const error = await persistInterviewTurnAtomic(turnInput()).catch(
      (caught) => caught,
    );
    expect(error.code).toBe("INTERVIEW_RPC_FAILED");
  });

  it("uses the generic persistence code for a transport failure", async () => {
    configured();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unavailable")),
    );
    const error = await persistInterviewTurnAtomic(turnInput()).catch(
      (caught) => caught,
    );
    expect(error.code).toBe("INTERVIEW_PERSISTENCE_FAILED");
  });

  it("defines all turn writes in the same PostgreSQL function", () => {
    const sql = readFileSync(
      "server/migrations/006_restore_interview_persistence_rpc.sql",
      "utf8",
    );
    expect(sql).toContain(
      "drop function if exists public.persist_interview_turn(uuid, uuid, jsonb, jsonb, jsonb, integer, jsonb, jsonb, jsonb)",
    );
    expect(sql).toContain("insert into public.interview_messages");
    expect(sql).toContain("insert into public.project_memory");
    expect(sql).toContain("insert into public.requirements");
    expect(sql).toContain("insert into public.acceptance_criteria");
    expect(sql).toContain("update public.interview_sessions");
    expect(sql).toContain("raise exception 'interview session update failed'");
    expect(sql).toContain("notify pgrst, 'reload schema'");
    expect(sql).toContain("p_acceptance_criteria jsonb");
    expect(sql).toContain("p_assistant_message jsonb");
    expect(sql).toContain("p_memory_version integer");
  });

  it("ships the missing acceptance-criteria relation as an idempotent repair", () => {
    const sql = readFileSync(
      "server/migrations/009_restore_acceptance_criteria.sql",
      "utf8",
    );
    expect(sql).toContain(
      "create table if not exists public.acceptance_criteria",
    );
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });

  it("uses partitioned production cookies for cross-site session persistence", () => {
    const routes = readFileSync("server/src/guidedRoutes.ts", "utf8");
    expect(routes).toContain("; Secure; SameSite=None; Partitioned");
  });
});

describe("Supabase authentication contract", () => {
  function configured() {
    process.env.SUPABASE_URL = "https://database.example";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  }

  it("validates a user with the anon API key and the access-token bearer", async () => {
    configured();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "user" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await userForToken("user-access-token", "req-auth-1");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      apikey: "anon",
      Authorization: "Bearer user-access-token",
    });
  });

  it("classifies a 403 session response without logging the bearer token", async () => {
    configured();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: "bad_jwt", message: "JWT expired" }),
            { status: 403 },
          ),
        ),
    );
    const error = await userForToken(
      "secret-user-access-token",
      "req-auth-2",
    ).catch((caught) => caught);
    expect(error.code).toBe("AUTH_VALIDATION_FAILED");
    const logs = log.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(logs).toContain('"operation":"auth.validate_session"');
    expect(logs).not.toContain("secret-user-access-token");
  });

  it("refreshes through the anon-key auth endpoint without exposing the refresh token", async () => {
    configured();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            user: { id: "user" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await refreshAuthSession("secret-refresh-token", "req-auth-3");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("grant_type=refresh_token");
    expect(init.headers).toMatchObject({ apikey: "anon" });
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({
      refresh_token: "secret-refresh-token",
    });
  });
});

describe("canonical lifecycle resolution", () => {
  it("opens each project at its latest valid persisted stage", () => {
    const base = snapshot();
    expect(resolveProjectWorkspaceMode(base)).toBe("interview");
    const architecture = {
      id: `architecture_${base.project.id}_1`,
      projectId: base.project.id,
      version: 1,
      diagramSource: "flowchart TD\nUser --> Application",
      summary: "summary",
      reasonForChange: "initial",
      createdAt: base.project.createdAt,
    };
    expect(resolveProjectWorkspaceMode({ ...base, architecture })).toBe(
      "architecture",
    );
    const srs = {
      id: `srs_${base.project.id}_1`,
      projectId: base.project.id,
      version: 1,
      title: "SRS",
      content: "draft",
      requirementIds: [],
      status: "draft" as const,
      createdAt: base.project.createdAt,
    };
    expect(resolveProjectWorkspaceMode({ ...base, architecture, srs })).toBe(
      "srs",
    );
    const implementationPlan = {
      id: "plan",
      prompt: "Implement",
      createdAt: base.project.createdAt,
    } as GuidedProjectSnapshot["implementationPlan"];
    expect(
      resolveProjectWorkspaceMode({
        ...base,
        architecture,
        srs,
        implementationPlan,
      }),
    ).toBe("implementation");
    expect(
      resolveProjectWorkspaceMode({
        ...base,
        project: { ...base.project, status: "iterating" },
        architecture,
        srs,
        implementationPlan,
      }),
    ).toBe("iteration");
    expect(
      safeProjectReturnMode({ snapshot: { ...base, implementationPlan } }),
    ).toBe("implementation");
  });

  it("never permits review or an implementation return without a plan", () => {
    const base = snapshot();
    expect(canReviewImplementation(base)).toBe(false);
    expect(safeProjectReturnMode({ snapshot: base })).toBe("interview");
    expect(
      canRenderProjectMode({ mode: "implementation", snapshot: base }),
    ).toBe(false);
    expect(canRenderProjectMode({ mode: "iteration", snapshot: base })).toBe(
      false,
    );
  });

  it("gives every invalid project mode a deterministic recoverable stage", () => {
    const base = snapshot();
    for (const mode of [
      "architecture",
      "srs",
      "implementation",
      "iteration",
    ] as const) {
      expect(canRenderProjectMode({ mode, snapshot: base })).toBe(false);
      expect(safeProjectReturnMode({ snapshot: base })).toBe("interview");
    }
  });
});

describe("persisted ID schema contract", () => {
  it("keeps interview messages UUID while domain version IDs remain text", () => {
    const schema = readFileSync(
      "server/migrations/001_guided_projects.sql",
      "utf8",
    );
    expect(schema).toMatch(
      /create table if not exists public\.interview_messages[\s\S]*?id uuid primary key/,
    );
    expect(schema).toMatch(
      /create table if not exists public\.architecture_versions[\s\S]*?id text primary key/,
    );
    expect(schema).toMatch(
      /create table if not exists public\.srs_documents[\s\S]*?id text primary key/,
    );
  });

  it("keeps opening messages on the server UUID generator and server approval gated", () => {
    const routes = readFileSync("server/src/guidedRoutes.ts", "utf8");
    expect(routes).toMatch(/const assistantMessage = \{\s*id: randomUUID\(\)/);
    expect(routes).toContain('memory.completeness.level !== "ready"');
    expect(routes).toContain('"SPECIFICATION_INCOMPLETE"');
  });
});

describe("account and iteration reliability migration", () => {
  it("applies review changes in one PostgreSQL transaction", () => {
    const sql = readFileSync(
      "server/migrations/008_account_and_iteration_reliability.sql",
      "utf8",
    );
    expect(sql).toContain(
      "create or replace function public.persist_iteration_change_approval",
    );
    expect(sql).toContain("insert into public.project_memory");
    expect(sql).toContain("insert into public.requirements");
    expect(sql).toContain("insert into public.acceptance_criteria");
    expect(sql).toContain("insert into public.srs_documents");
    expect(sql).toContain("insert into public.architecture_versions");
    expect(sql).toContain("insert into public.project_iterations");
    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/m);
  });

  it("uses a shared database-backed authentication limiter", () => {
    const sql = readFileSync(
      "server/migrations/008_account_and_iteration_reliability.sql",
      "utf8",
    );
    const routes = readFileSync("server/src/guidedRoutes.ts", "utf8");
    expect(sql).toContain("create table if not exists public.auth_rate_limits");
    expect(sql).toContain(
      "create or replace function public.consume_auth_rate_limit",
    );
    expect(sql).toContain("on conflict (key_hash) do update");
    expect(routes).toContain("await consumeAuthRateLimit(keyHash)");
    expect(routes).not.toContain("const authAttempts = new Map");
  });
});
