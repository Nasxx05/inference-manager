import { describe, expect, it } from "vitest";
import { buildTraceability, createIteration, extractChangeRequests, findingsFromTraceability, generateIterationPrompt, suggestionsForProject } from "@/lib/iteration";
import type { ProjectMemory, ProjectRecord } from "@/types/project";

const project: ProjectRecord = { id: "project_test", userId: "user_test", title: "Restaurant", initialDescription: "A restaurant ordering site with pay on delivery.", projectType: "web-development", selectedModel: "claude-sonnet", planningDepth: "balanced", creditBudget: 10, status: "approved", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const memory: ProjectMemory = { projectId: project.id, purpose: project.initialDescription, projectType: project.projectType, users: ["customers"], requirements: [{ id: "req_booking", projectId: project.id, type: "functional", category: "core_functionality", description: "Customers can place restaurant orders", priority: "high", required: true, source: "user", status: "confirmed", confidence: "high", dependencies: [], version: 1, createdAt: project.createdAt, updatedAt: project.updatedAt }], conflicts: [], assumptions: [], risks: [], openQuestions: [], designPreferences: [], technicalConstraints: [], acceptanceCriteria: ["A customer can place an order."], completeness: { level: "ready", score: 90, criticalGaps: [], optionalGaps: [], explanation: "Ready" }, version: 1, updatedAt: project.updatedAt };

describe("iteration foundation", () => {
  it("numbers iterations sequentially and extracts separate user changes", () => {
    const first = createIteration({ project, existing: [] });
    const second = createIteration({ project, existing: [first] });
    const changes = extractChangeRequests({ iterationId: second.id, projectId: project.id, text: "Change the hero and add availability calendar." });
    expect(second.sequenceNumber).toBe(2);
    expect(changes).toHaveLength(2);
    expect(changes.map((item) => item.category)).toContain("visual_change");
    expect(changes.map((item) => item.category)).toContain("feature_addition");
  });

  it("distinguishes missing implementation evidence from unverifiable behavior", () => {
    const iteration = createIteration({ project, existing: [] });
    const missing = buildTraceability({ iteration, requirements: memory.requirements, evidenceText: "Repository: empty shell\nFiles: src/app/page.tsx", hasRepository: true });
    expect(missing.traceability[0]?.status).toBe("missing");
    expect(findingsFromTraceability({ iteration, traceability: missing.traceability })[0]?.type).toBe("required_fix");
    const unknown = buildTraceability({ iteration, requirements: memory.requirements, evidenceText: "", hasRepository: false });
    expect(unknown.traceability[0]?.status).toBe("cannot_verify");
  });

  it("keeps optional opportunities separate from required fixes", () => {
    const iteration = createIteration({ project, existing: [] });
    const suggestions = suggestionsForProject({ iteration, projectType: project.projectType, memoryText: "restaurant ordering pay on delivery" });
    expect(suggestions.some((item) => item.title === "Online Payments")).toBe(true);
    expect(suggestions[0]?.status).toBe("proposed");
  });

  it("excludes rejected suggestions from the generated iteration prompt", () => {
    const iteration = createIteration({ project, existing: [] });
    const prompt = generateIterationPrompt({ iteration: { ...iteration, repositorySnapshot: { repositoryUrl: "https://github.com/example/app", commitSha: "abc123", branch: "main", reviewedAt: project.createdAt, fileCount: 1, relevantFiles: ["src/app.ts"], structuralSummary: "", evidenceText: "", status: "reviewed" }, suggestions: [{ id: "suggestion_1", projectId: project.id, iterationId: iteration.id, title: "Online Payments", description: "Accept online payments", rationale: "", expectedBenefit: "", implementationImpact: "medium", architectureAffected: true, requirementsAffected: [], confidence: "medium", status: "rejected", createdAt: project.createdAt }] }, memory, srs: { id: "srs_1", projectId: project.id, version: 1, title: "SRS", content: "Approved SRS", requirementIds: ["req_booking"], status: "approved", createdAt: project.createdAt } });
    expect(prompt.prompt).not.toContain("Accept online payments");
    expect(prompt.prompt).toContain("Rejected suggestions intentionally excluded");
  });
});
