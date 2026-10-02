import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";
import { validateInterviewProposal } from "@/lib/projectMemory/proposals";
import { buildTechnicalBlueprint } from "@/lib/technicalBlueprint";
import { compileImplementationPrompt, inferPromptDepth, validateCompiledPrompt } from "@/lib/prompts";
import type { ProjectMemory } from "@/types/project";

const now = "2026-01-01T00:00:00.000Z";

function restaurantMemory(): ProjectMemory {
  const project = createProjectRecord({ id: "project_restaurant", userId: "user", description: "A restaurant website where customers view the menu, reserve tables, and contact the restaurant", modelId: "auto", planningDepth: "balanced", budget: 10, now });
  const memory = createInitialMemory(project, now);
  const base = memory.requirements[0]!;
  memory.users = ["Customer", "Restaurant administrator"];
  memory.mvpScope = ["Customers can view the menu", "Customers can request a table reservation", "Visitors can contact the restaurant", "Administrators can confirm reservation requests"];
  memory.deferredScope = ["Online ordering", "Online payments", "Delivery logistics"];
  memory.workflows = ["Customer submits a reservation request and sees confirmation that it is pending"];
  memory.adminWorkflows = ["Restaurant administrator reviews and manually confirms a reservation"];
  memory.requirements = [
    { ...base, id: "req_menu", description: "Customers can view published menu items", status: "confirmed", type: "functional", category: "core_functionality" },
    { ...base, id: "req_reservation", description: "Customers can request a reservation date and the restaurant manually confirms it", status: "confirmed", type: "functional", category: "workflows" },
    { ...base, id: "req_contact", description: "Visitors can submit a contact request", status: "confirmed", type: "functional", category: "workflows" },
    { ...base, id: "req_admin", description: "Only restaurant administrators can manage reservation status", status: "confirmed", type: "security", category: "security" },
  ];
  memory.acceptanceCriteria = ["A valid reservation request is persisted with pending status", "An unauthenticated visitor cannot access reservation administration", "The website has no horizontal overflow on a 320px viewport"];
  memory.projectPhase = "ready_to_build";
  memory.version = 4;
  return memory;
}

describe("Technical Blueprint", () => {
  it("recommends a coherent beginner-friendly stack when the user supplied none", () => {
    const blueprint = buildTechnicalBlueprint({ memory: restaurantMemory(), now });
    expect(blueprint.recommendedStack.frontend?.technology).toContain("Next.js");
    expect(blueprint.recommendedStack.database?.technology).toContain("PostgreSQL");
    expect(blueprint.recommendedStack.frontend?.rationale.length).toBeGreaterThan(30);
  });

  it("prefers an existing repository stack", () => {
    const memory = restaurantMemory();
    const blueprint = buildTechnicalBlueprint({ memory, repositoryEvidence: { url: "https://github.com/example/app", commitSha: "abc123", existingStack: ["Django + Python", "PostgreSQL"], relevantFiles: ["manage.py"] }, now });
    expect(blueprint.recommendedStack.backend?.technology).toBe("Django + Python");
    expect(blueprint.recommendedStack.backend?.status).toBe("existing");
  });

  it("lets an explicit confirmed stack override defaults", () => {
    const memory = restaurantMemory();
    memory.confirmedStack = ["FastAPI + Python", "PostgreSQL"];
    const blueprint = buildTechnicalBlueprint({ memory, now });
    expect(blueprint.recommendedStack.backend?.technology).toBe("FastAPI + Python");
    expect(blueprint.recommendedStack.backend?.status).toBe("confirmed");
  });

  it("reuses an unchanged version and increments meaningful changes", () => {
    const memory = restaurantMemory();
    const first = buildTechnicalBlueprint({ memory, now });
    expect(buildTechnicalBlueprint({ memory, previous: first, now: "2026-01-02T00:00:00.000Z" })).toBe(first);
    const changed = buildTechnicalBlueprint({ memory: { ...memory, deferredScope: [...(memory.deferredScope ?? []), "Customer loyalty"] }, previous: first, now });
    expect(changed.version).toBe(first.version + 1);
  });

  it("derives workflows, pages, data, APIs, security, architecture, and phases", () => {
    const blueprint = buildTechnicalBlueprint({ memory: restaurantMemory(), now });
    expect(blueprint.workflows.some((item) => /reservation/i.test(item.name))).toBe(true);
    expect(blueprint.pages.some((item) => item.route === "/booking")).toBe(true);
    expect(blueprint.dataEntities.some((item) => item.name === "reservations")).toBe(true);
    expect(blueprint.apiSurface.length).toBeGreaterThan(0);
    expect(blueprint.security.some((item) => item.area === "Authorization")).toBe(true);
    expect(blueprint.architecture.mermaid).toContain("flowchart LR");
    expect(blueprint.implementationPhases.length).toBeGreaterThanOrEqual(4);
  });

  it("records unknown critical context as assumptions and warnings", () => {
    const project = createProjectRecord({ id: "unknown", userId: "user", description: "Build something", modelId: "auto", planningDepth: "fast", budget: 2, now });
    const memory = createInitialMemory(project, now); memory.users = []; memory.mvpScope = [];
    const blueprint = buildTechnicalBlueprint({ memory, now });
    expect(blueprint.quality).toBe("incomplete");
    expect(blueprint.assumptions.join(" ")).toMatch(/Primary users|MVP scope/i);
  });

  it("produces a useful URL-shortener skeleton even before every detail is confirmed", () => {
    const project = createProjectRecord({ id: "shortener", userId: "user", description: "Build a simple URL shortener that redirects short links and shows basic click counts", modelId: "auto", planningDepth: "balanced", budget: 5, now });
    const blueprint = buildTechnicalBlueprint({ memory: createInitialMemory(project, now), now });
    expect(blueprint.pages.some((page) => page.name === "Link workspace")).toBe(true);
    expect(blueprint.dataEntities.some((entity) => entity.name === "short_links")).toBe(true);
    expect(blueprint.architecture.mermaid).toContain("DB[(Supabase PostgreSQL)]");
  });
});

describe("Prompt Compiler", () => {
  it("compiles a comprehensive full MVP prompt grounded in the blueprint", () => {
    const memory = restaurantMemory();
    const blueprint = buildTechnicalBlueprint({ memory, now });
    const prompt = compileImplementationPrompt({ kind: "implementation", memory, technicalBlueprint: blueprint, userRequest: "Generate the complete implementation prompt for the first version" });
    expect(prompt.depth).toBe("full_mvp");
    for (const section of ["Recommended Technology Stack", "System Architecture", "Pages and Screens", "User Workflows", "Data Model", "Authentication", "Authorization", "Security", "Implementation Phases", "Testing Requirements", "Deployment", "Acceptance Criteria", "Final Implementation Report"]) expect(prompt.content).toContain(`## ${section}`);
    expect(prompt.content).toContain("```mermaid");
    expect(prompt.content).toContain("Supabase PostgreSQL");
    expect(prompt.content).toContain("Online payments");
    expect(prompt.content).toContain("manually confirms");
    expect(validateCompiledPrompt(prompt.content, prompt.depth).valid).toBe(true);
  });

  it("keeps a quick fix prompt focused", () => {
    const memory = restaurantMemory(); const blueprint = buildTechnicalBlueprint({ memory, now });
    const quick = compileImplementationPrompt({ kind: "correction", memory, technicalBlueprint: blueprint, userRequest: "Quick fix mobile overflow" });
    const full = compileImplementationPrompt({ kind: "implementation", memory, technicalBlueprint: blueprint, userRequest: "Generate the complete implementation prompt for the MVP" });
    expect(quick.depth).toBe("quick_fix");
    expect(quick.content.length).toBeLessThan(full.content.length / 2);
  });

  it("includes exact repository evidence in correction prompts", () => {
    const memory = restaurantMemory();
    const blueprint = buildTechnicalBlueprint({ memory, repositoryEvidence: { url: "https://github.com/example/restaurant", commitSha: "abcdef1234567890", existingStack: ["Django + Python"], relevantFiles: ["bookings/views.py"] }, now });
    const prompt = compileImplementationPrompt({ kind: "correction", depth: "repository_correction", memory, technicalBlueprint: blueprint, userRequest: "Fix the booking authorization", reviewFindings: ["The update handler does not verify the administrator role."] });
    expect(prompt.content).toContain("abcdef1234567890");
    expect(prompt.content).toContain("bookings/views.py");
    expect(prompt.content).toContain("does not verify the administrator role");
  });

  it("uses ecosystem-appropriate verification guidance", () => {
    const memory = restaurantMemory(); memory.confirmedStack = ["FastAPI + Python", "PostgreSQL"];
    const blueprint = buildTechnicalBlueprint({ memory, now });
    const prompt = compileImplementationPrompt({ kind: "implementation", depth: "full_mvp", memory, technicalBlueprint: blueprint, userRequest: "Generate prompt" });
    expect(prompt.content).toContain("pytest");
  });

  it("infers adaptive depth", () => {
    const memory = restaurantMemory();
    expect(inferPromptDepth({ userRequest: "Quick fix the mobile overflow", memory })).toBe("quick_fix");
    expect(inferPromptDepth({ userRequest: "Generate the implementation prompt", memory })).toBe("full_mvp");
    expect(inferPromptDepth({ userRequest: "Fix the review findings", memory, hasRepository: true })).toBe("repository_correction");
  });
});

describe("rich conversation memory validation", () => {
  it("accepts supported technical proposals without silently confirming them", () => {
    const memory = restaurantMemory(); memory.proposedStack = []; memory.confirmedStack = [];
    const proposal = validateInterviewProposal({ raw: { proposedStack: ["Next.js + TypeScript", "Supabase PostgreSQL"], hosting: ["Vercel"], database: ["reservations table"], architectureSummary: "A web client calls a trusted server layer." }, memory, userContent: "I do not know what technology to use", sourceMessageId: "message", now, fallbackToUserContent: false });
    expect(proposal.proposedStack).toContain("Next.js + TypeScript");
    expect(proposal.confirmedStack).toEqual([]);
    expect(proposal.architectureSummary).toContain("trusted server");
  });

  it("confirms only an existing recommendation after explicit approval", () => {
    const memory = restaurantMemory(); memory.proposedStack = ["Next.js + TypeScript", "Supabase PostgreSQL"]; memory.confirmedStack = [];
    const proposal = validateInterviewProposal({ raw: { confirmedStack: ["Next.js + TypeScript", "Supabase PostgreSQL"] }, memory, userContent: "Okay, use that recommendation", sourceMessageId: "message", now, fallbackToUserContent: false });
    expect(proposal.confirmedStack).toEqual(memory.proposedStack);
  });

  it("accepts an explicit user technology override", () => {
    const memory = restaurantMemory(); memory.proposedStack = ["Next.js + TypeScript"]; memory.confirmedStack = [];
    const proposal = validateInterviewProposal({ raw: { confirmedStack: ["FastAPI + Python"] }, memory, userContent: "I want to use Python for the backend", sourceMessageId: "message", now, fallbackToUserContent: false });
    expect(proposal.confirmedStack).toEqual(["FastAPI + Python"]);
  });

  it("ships an additive stale-prompt migration", () => {
    const sql = readFileSync("server/migrations/012_prompt_staleness.sql", "utf8");
    expect(sql).toContain("supersede_stale_project_prompts");
    expect(sql).toContain("implementation_prompt");
    expect(sql).toContain("new.version");
  });
});
