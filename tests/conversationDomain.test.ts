import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeProjectMemory,
  phaseForLegacyStatus,
} from "@/lib/projectMemory/compatibility";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory/intake";

describe("conversation product compatibility", () => {
  it("maps every legacy lifecycle status to a beginner-facing phase", () => {
    expect(phaseForLegacyStatus("intake")).toBe("exploring");
    expect(phaseForLegacyStatus("interviewing")).toBe("shaping");
    expect(phaseForLegacyStatus("srs_ready")).toBe("ready_to_build");
    expect(phaseForLegacyStatus("implementation")).toBe("building");
    expect(phaseForLegacyStatus("reviewing_repository")).toBe("reviewing");
    expect(phaseForLegacyStatus("iterating")).toBe("improving");
    expect(phaseForLegacyStatus("completed")).toBe("completed");
  });

  it("normalizes legacy memory without changing established facts", () => {
    const project = createProjectRecord({
      id: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      description: "Build a restaurant website",
      modelId: "openai/gpt-4o",
      planningDepth: "balanced",
      budget: 10,
      now: "2026-09-30T00:00:00.000Z",
    });
    const current = createInitialMemory(project, project.createdAt);
    const legacy = {
      ...current,
      secondaryUsers: undefined,
      projectPhase: undefined,
      connectedRepository: undefined,
      artifactVersions: undefined,
    };
    const normalized = normalizeProjectMemory(legacy);

    expect(normalized.purpose).toBe("Build a restaurant website");
    expect(normalized.requirements).toEqual(current.requirements);
    expect(normalized.secondaryUsers).toEqual([]);
    expect(normalized.projectPhase).toBe("exploring");
    expect(normalized.connectedRepository).toBeNull();
    expect(normalized.artifactVersions).toEqual({});
  });

  it("creates new projects in auto or locked model mode without a formal gate", () => {
    const base = {
      userId: "user",
      description: "Build a portfolio",
      planningDepth: "balanced" as const,
      budget: 5,
    };
    expect(createProjectRecord({ ...base, modelId: "auto" }).modelMode).toBe("auto");
    expect(createProjectRecord({ ...base, modelId: "openai/gpt-4o" }).modelMode).toBe("locked");
  });
});

describe("migration 010 contract", () => {
  const sql = readFileSync(
    new URL("../server/migrations/010_conversation_product_foundation.sql", import.meta.url),
    "utf8",
  );

  it.each([
    "project_artifacts",
    "project_decisions",
    "model_routes",
    "repository_connections",
    "test_runs",
    "project_actions",
  ])("creates and protects %s", (table) => {
    expect(sql).toContain(`create table if not exists public.${table}`);
    expect(sql).toContain(`alter table public.${table} enable row level security`);
  });

  it("is additive and refreshes the PostgREST schema cache", () => {
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/delete from public\./i);
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});

describe("atomic conversation migration contract", () => {
  const sql = readFileSync(
    new URL("../server/migrations/011_atomic_conversation_turn.sql", import.meta.url),
    "utf8",
  );

  it("persists the complete turn and review side effects in one function", () => {
    expect(sql).toContain("persist_conversation_turn");
    expect(sql).toContain("p_user_message jsonb");
    expect(sql).toContain("p_assistant_message jsonb");
    expect(sql).toContain("p_repository_snapshot jsonb");
    expect(sql).toContain("p_test_run jsonb");
    expect(sql).toContain("insert into public.project_artifacts");
    expect(sql).toContain("insert into public.repository_connections");
    expect(sql).toContain("insert into public.test_runs");
    expect(sql).toContain("create or replace function public.persist_project_bootstrap");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
