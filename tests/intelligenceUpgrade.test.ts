import { describe, expect, it } from "vitest";
import { createInitialMemory, createProjectRecord, generateSrs, structuredAcceptanceCriteria, validateInterviewProposal } from "@/lib/projectMemory";
import { createIteration, validateSemanticReview } from "@/lib/iteration";
import type { AcceptanceCriterion, ProjectMemory, Requirement } from "@/types/project";
import type { ProjectIteration, ProjectSuggestion } from "@/types/iteration";

const now = "2026-09-27T00:00:00.000Z";
const project = createProjectRecord({ id: "project_intelligence", userId: "user_1", description: "A restaurant reservation website", modelId: "gpt-4o", planningDepth: "balanced", budget: 20, now });

function memory(): ProjectMemory { return createInitialMemory(project, now); }

describe("structured requirements proposals", () => {
  it("extracts multiple atomic confirmed requirements from one user answer", () => {
    const current = memory();
    const answer = "Customers create accounts, reserve tables, receive confirmation emails, and admins manage availability.";
    const raw = { requirements: [
      { description: "Customers create accounts", type: "functional", category: "core_functionality", sourceEvidence: "Customers create accounts", confidence: "high" },
      { description: "Customers reserve tables", type: "functional", category: "core_functionality", sourceEvidence: "reserve tables", confidence: "high" },
      { description: "Customers receive confirmation emails", type: "integration", category: "integrations", sourceEvidence: "receive confirmation emails", confidence: "high" },
      { description: "Administrators manage availability", type: "functional", category: "workflows", sourceEvidence: "admins manage availability", confidence: "high" },
    ] };
    const result = validateInterviewProposal({ raw, memory: current, userContent: answer, sourceMessageId: "message_1", now });
    const added = result.requirements.filter((item) => item.sourceMessageId === "message_1");
    expect(added).toHaveLength(4);
    expect(added.every((item) => item.source === "user" && item.status === "confirmed")).toBe(true);
    expect(added.every((item) => !item.description.includes(","))).toBe(true);
  });

  it("keeps model inference separate from user confirmation", () => {
    const result = validateInterviewProposal({ raw: { requirements: [
      { description: "Customers can reserve tables", sourceEvidence: "Customers reserve tables" },
      { description: "Customers can pay online", sourceEvidence: "" },
    ] }, memory: memory(), userContent: "Customers reserve tables.", sourceMessageId: "message_2", now });
    expect(result.requirements.find((item) => item.description.includes("reserve tables"))?.status).toBe("confirmed");
    expect(result.requirements.find((item) => item.description.includes("pay online"))?.status).toBe("proposed");
  });

  it("preserves a stable requirement id for semantic duplicates", () => {
    const current = memory();
    const existing: Requirement = { id: "req_reserve", projectId: project.id, type: "functional", category: "core_functionality", description: "Customers can reserve tables", priority: "high", required: true, source: "user", status: "confirmed", confidence: "high", dependencies: [], version: 1, createdAt: now, updatedAt: now };
    current.requirements.push(existing);
    const beforeCount = current.requirements.length;
    const result = validateInterviewProposal({ raw: { requirements: [{ description: "Users should be able to make table reservations", sourceEvidence: "Users should be able to make table reservations" }] }, memory: current, userContent: "Users should be able to make table reservations.", sourceMessageId: "message_3", now });
    expect(result.requirements.filter((item) => item.id === existing.id)).toHaveLength(1);
    expect(result.requirements).toHaveLength(beforeCount);
  });

  it("links acceptance criteria and rejects criteria that silently expand scope", () => {
    const current = memory();
    const result = validateInterviewProposal({ raw: { requirements: [{ description: "Customers can reserve available tables", sourceEvidence: "reserve available tables" }], acceptanceCriteria: [
      { requirementDescription: "Customers can reserve available tables", description: "Unavailable slots cannot be selected", sourceEvidence: "available tables" },
      { requirementDescription: "Customers can reserve available tables", description: "Customers can pay online", sourceEvidence: "" },
    ] }, memory: current, userContent: "Customers can reserve available tables.", sourceMessageId: "message_4", now });
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.acceptanceCriteria[0]?.requirementId).toBeTruthy();
    expect(result.acceptanceCriteria[0]?.description).toContain("Unavailable slots");
    const srs = generateSrs({ memory: { ...current, requirements: result.requirements, acceptanceCriteria: result.acceptanceCriteria } });
    expect(srs.content).toContain(result.acceptanceCriteria[0]!.id);
    expect(srs.content).toContain(result.acceptanceCriteria[0]!.requirementId);
  });

  it("migrates legacy string acceptance criteria without crashing", () => {
    const current = memory();
    current.acceptanceCriteria = ["A customer can complete a reservation."];
    const criteria = structuredAcceptanceCriteria(current, now);
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.projectId).toBe(project.id);
  });
});

function reviewFixture(): { memory: ProjectMemory; iteration: ProjectIteration; criteria: AcceptanceCriterion[] } {
  const current = memory();
  const requirement: Requirement = { id: "FR-003", projectId: project.id, type: "functional", category: "core_functionality", description: "Customers can reserve available tables", priority: "high", required: true, source: "user", status: "confirmed", confidence: "high", dependencies: [], version: 1, createdAt: now, updatedAt: now };
  const criteria: AcceptanceCriterion[] = ["choose-date", "choose-time", "block-slot", "email"].map((key, index) => ({ id: `AC-003.${index + 1}`, projectId: project.id, requirementId: requirement.id, description: key, source: "user", status: "confirmed", confidence: "high", version: 1, createdAt: now, updatedAt: now }));
  const nextMemory = { ...current, requirements: [requirement], acceptanceCriteria: criteria };
  const iteration = { ...createIteration({ project, existing: [], now }), repositorySnapshot: { repositoryUrl: "https://github.com/example/app", commitSha: "abc", reviewedAt: now, fileCount: 2, relevantFiles: ["src/app/reservations/page.tsx", "src/api/reservations/route.ts"], structuralSummary: "", evidenceText: "", status: "reviewed" as const } };
  return { memory: nextMemory, iteration, criteria };
}

describe("validated semantic review", () => {
  it("derives a partial parent requirement when one criterion is missing", () => {
    const fixture = reviewFixture();
    const raw = { summary: "Reservations are incomplete.", traceability: [{ requirementId: "FR-003", status: "satisfied", reason: "Reservation UI and route exist.", evidence: [{ type: "repository_file", file: "src/api/reservations/route.ts", explanation: "Reservation handler exists.", confidence: "high" }], acceptanceCriteria: fixture.criteria.map((criterion, index) => ({ criterionId: criterion.id, status: index === 2 ? "missing" : "satisfied", reason: index === 2 ? "No collision check found." : "Relevant implementation found.", evidence: [], confidence: "medium", runtimeVerificationRequired: false })) }], suggestions: [], technicalFindings: [] };
    const result = validateSemanticReview({ raw, iteration: fixture.iteration, memory: fixture.memory, now });
    expect(result.traceability[0]?.status).toBe("partially_satisfied");
    expect(result.traceability[0]?.acceptanceCriteria.filter((item) => item.status === "satisfied")).toHaveLength(3);
    expect(result.traceability[0]?.acceptanceCriteria.filter((item) => item.status === "missing")).toHaveLength(1);
  });

  it("drops hallucinated repository evidence paths", () => {
    const fixture = reviewFixture();
    const raw = { summary: "Review", traceability: [{ requirementId: "FR-003", status: "satisfied", reason: "Claim", evidence: [{ type: "repository_file", file: "src/payments/fake.ts", explanation: "Invented", confidence: "high" }], acceptanceCriteria: [] }], suggestions: [], technicalFindings: [] };
    const result = validateSemanticReview({ raw, iteration: fixture.iteration, memory: fixture.memory, now });
    expect(result.evidence).toHaveLength(0);
    expect(result.traceability[0]?.evidenceIds).toHaveLength(0);
  });

  it("does not turn source presence into runtime proof", () => {
    const fixture = reviewFixture();
    const raw = { summary: "Review", traceability: [{ requirementId: "FR-003", status: "satisfied", reason: "Email code exists.", evidence: [], acceptanceCriteria: [{ criterionId: "AC-003.4", status: "satisfied", reason: "Mailer is called.", evidence: [], confidence: "medium", runtimeVerificationRequired: true }] }], suggestions: [], technicalFindings: [] };
    const result = validateSemanticReview({ raw, iteration: fixture.iteration, memory: fixture.memory, now });
    expect(result.traceability[0]?.acceptanceCriteria[0]?.status).toBe("cannot_verify");
    expect(result.traceability[0]?.status).toBe("cannot_verify");
  });

  it("does not resurface a previously rejected suggestion", () => {
    const fixture = reviewFixture();
    const rejected: ProjectSuggestion = { id: "suggestion_old", projectId: project.id, iterationId: "iteration_old", title: "Online Payments", description: "Add payments", rationale: "Optional", expectedBenefit: "Faster payment", implementationImpact: "high", architectureAffected: true, requirementsAffected: [], confidence: "medium", status: "rejected", createdAt: now };
    const raw = { summary: "Review", traceability: [], technicalFindings: [], suggestions: [{ title: "Online Payments", description: "Add card payments", rationale: "Optional", expectedBenefit: "Faster payment", implementationImpact: "high", architectureAffected: true, requirementsAffected: [], confidence: "medium" }] };
    const result = validateSemanticReview({ raw, iteration: fixture.iteration, memory: fixture.memory, previousSuggestions: [rejected], now });
    expect(result.suggestions).toHaveLength(0);
  });
});
