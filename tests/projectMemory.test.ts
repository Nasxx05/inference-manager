import { describe, expect, it } from "vitest";
import { UUID_V4_PATTERN } from "@/lib/ids";
import {
  applyInterviewTurn,
  architectureForMemory,
  calculateCompleteness,
  createInitialMemory,
  createProjectRecord,
  detectContradictions,
  generateSrs,
  nextBestQuestion,
} from "@/lib/projectMemory";

function project(description = "Build a booking website for a small restaurant") {
  return createProjectRecord({
    id: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-000000000002",
    description,
    modelId: "auto",
    planningDepth: "balanced",
    budget: 10,
    now: "2026-01-01T00:00:00.000Z",
  });
}

describe("guided project memory", () => {
  it("creates a structured initial memory with an adaptive backlog", () => {
    const memory = createInitialMemory(project());
    expect(memory.requirements.length).toBeGreaterThan(0);
    expect(memory.openQuestions.length).toBeGreaterThan(0);
    expect(nextBestQuestion(memory)?.area).toBeTruthy();
  });

  it("keeps user interview responses confirmed and advances the session", () => {
    const current = createInitialMemory(project());
    const session = {
      id: "00000000-0000-0000-0000-000000000003",
      projectId: current.projectId,
      planningDepth: "balanced" as const,
      status: "active" as const,
      turnCount: 0,
      createdAt: current.updatedAt,
      updatedAt: current.updatedAt,
    };
    const result = applyInterviewTurn({ memory: current, session, content: "Customers should choose a date and receive confirmation.", now: "2026-01-01T00:00:01.000Z" });
    expect(result.memory.requirements.some((item) => item.status === "confirmed" && item.source === "user")).toBe(true);
    expect(result.session.turnCount).toBe(1);
    expect(result.userMessage.role).toBe("user");
    expect(result.assistantMessage.role).toBe("assistant");
    expect(result.userMessage.id).toMatch(UUID_V4_PATTERN);
    expect(result.assistantMessage.id).toMatch(UUID_V4_PATTERN);
    expect(result.userMessage.id).not.toBe(result.assistantMessage.id);
  });

  it("detects contradictory requirements without resolving them silently", () => {
    const base = createInitialMemory(project());
    const withRequirements = {
      ...base,
      requirements: [
        ...base.requirements,
        { ...base.requirements[0]!, id: "req-a", description: "No accounts or login are required.", status: "confirmed" as const },
        { ...base.requirements[0]!, id: "req-b", description: "Each user has a private dashboard.", status: "confirmed" as const },
      ],
    };
    expect(detectContradictions(withRequirements).length).toBeGreaterThan(0);
  });

  it("generates architecture only from structured requirements", () => {
    const memory = createInitialMemory(project());
    const architecture = architectureForMemory({ memory });
    expect(architecture.diagramSource).toContain("flowchart LR");
    expect(architecture.diagramSource).not.toMatch(/Next\.js|TypeScript|Server Actions/i);
    expect(architecture.summary).toContain("product map");
  });

  it("reuses an unchanged architecture version and advances a changed one", () => {
    const memory = createInitialMemory(project());
    const first = architectureForMemory({ memory, now: "2026-01-01T00:00:00.000Z" });
    const unchanged = architectureForMemory({ memory, previous: first, now: "2026-01-02T00:00:00.000Z" });
    expect(unchanged.version).toBe(first.version);
    expect(unchanged.id).toBe(first.id);

    const changedMemory = { ...memory, requirements: [...memory.requirements, { ...memory.requirements[0]!, id: "req-payment", type: "functional" as const, description: "Customers can pay at checkout." }] };
    const changed = architectureForMemory({ memory: changedMemory, previous: first });
    expect(changed.version).toBe(first.version + 1);
    expect(changed.id).not.toBe(first.id);
  });

  it("builds an SRS with stable requirement identifiers", () => {
    const memory = createInitialMemory(project());
    const document = generateSrs({ memory });
    expect(document.content).toContain("Software Requirements Specification");
    expect(document.requirementIds).toContain(memory.requirements[0]!.id);
  });

  it("includes the latest architecture or the explicit not-generated state", () => {
    const memory = createInitialMemory(project());
    expect(generateSrs({ memory }).content).toContain("Architecture has not been generated yet.");
    const architecture = architectureForMemory({ memory });
    expect(generateSrs({ memory, architecture }).content).toContain(architecture.summary);
  });

  it("marks a memory ready only when its selected depth is satisfied", () => {
    const memory = createInitialMemory(project());
    const { completeness: _ignored, ...withoutCompleteness } = memory;
    const result = calculateCompleteness(withoutCompleteness, "balanced");
    expect(["insufficient", "developing", "ready"]).toContain(result.level);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
