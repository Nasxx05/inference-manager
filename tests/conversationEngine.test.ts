import { describe, expect, it } from "vitest";
import { routeConversationIntents } from "@/lib/conversation/intentRouter";
import { composeConversationContext, conversationContextLimit } from "@/lib/conversation/contextComposer";
import { validatePromgentResponse } from "@/lib/conversation/responseContract";
import { applyConversationTurn } from "@/lib/conversation/conversationTurn";
import { formatEngineeringGuidance } from "@/lib/conversation/engineeringGuidance";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory/intake";
import type { InterviewSession } from "@/types/project";

const now = "2026-09-30T00:00:00.000Z";
const project = createProjectRecord({ id: "00000000-0000-4000-8000-000000000001", userId: "user", description: "A restaurant website", modelId: "auto", planningDepth: "balanced", budget: 8, now });
const memory = createInitialMemory(project, now);
const session: InterviewSession = { id: "00000000-0000-4000-8000-000000000002", projectId: project.id, planningDepth: "balanced", status: "active", turnCount: 0, createdAt: now, updatedAt: now };

describe("intent router", () => {
  it.each([
    ["Why do I need a database?", "technical_explanation"],
    ["Show me the architecture", "architecture_request"],
    ["Generate the prompt for the first version", "prompt_generation"],
    ["Generate a complete implementation prompt for this MVP, including the architecture and how to verify it.", "prompt_generation"],
    ["I built it https://github.com/example/project", "repository_review"],
    ["Actually remove payments for now", "change_request"],
    ["What should I do next?", "next_step_request"],
  ])("routes %s", (message, intent) => expect(routeConversationIntents(message)).toContain(intent));

  it("supports combined intents", () => {
    expect(routeConversationIntents("Add payments and generate a prompt")).toEqual(expect.arrayContaining(["change_request", "prompt_generation"]));
  });
});

describe("conversation contract and state", () => {
  it("keeps a normal technical question from altering scope", () => {
    const intents = routeConversationIntents("Why do I need a database?");
    const response = validatePromgentResponse({ message: "A database stores reservations so they survive refreshes." }, intents);
    const result = applyConversationTurn({ memory, session, content: "Why do I need a database?", source: "text", intents, response, structuredMemoryProposal: { requirements: [{ description: "Add cryptocurrency payments" }] }, now, generateId: (() => { let i = 0; return () => `00000000-0000-4000-8000-${String(++i).padStart(12, "0")}`; })() });
    expect(result.memory.requirements).toEqual(memory.requirements);
    expect(result.assistantMessage.content).toContain("stores reservations");
  });

  it("validates useful artifact requests but ignores unknown artifact types", () => {
    const response = validatePromgentResponse({ message: "Here is the current design.", artifactRequests: [{ type: "architecture", reason: "The user asked for it" }, { type: "malware", reason: "invalid" }] }, ["architecture_request"]);
    expect(response.artifactRequests).toEqual([{ type: "architecture", reason: "The user asked for it" }]);
  });

  it("turns structured engineering judgment into a beginner-readable response", () => {
    const response = validatePromgentResponse({
      message: "A booking flow is the core of this product.",
      guidance: {
        overview: "A booking product coordinates a customer's request with the barber's real availability. It replaces an informal message exchange with a visible, reliable process.",
        assessment: "The customer needs to request a time and the barber needs to confirm it.",
        productBehavior: "A customer chooses a service and time, then submits the request.\n- The system validates availability.\n- It saves the booking and shows a clear confirmation without allowing duplicate appointments.",
        recommendation: "Build one request-and-confirm workflow before adding payments.",
        rationale: ["This proves the operational value with less risk."],
        features: [{ name: "Booking request", explanation: "The customer selects a service and an available time. The server rejects invalid or newly occupied slots before saving anything.", whyItMatters: "This is the core customer outcome." }],
        mvpNow: ["Customer submits a booking request", "Barber confirms or declines it"],
        technicalApproach: "Use a responsive web client for the booking form, a trusted server operation for availability rules, and a relational database for durable bookings.",
        stack: [{ technology: "Next.js", purpose: "Web interface and server operations", reason: "It keeps the small MVP in one typed codebase." }],
        userJourney: [{ step: "Choose a time", explanation: "The customer sees currently available slots and selects one before entering contact details." }],
        screens: [{ name: "Booking", purpose: "Lets a customer complete a booking request without leaving the page.", keyElements: ["Service selector", "Available times", "Confirmation state"] }],
        architectureExplanation: "The browser calls trusted booking logic, which validates and persists the appointment.",
        riskMitigations: [{ risk: "Two customers may request the same time", mitigation: "Enforce a database uniqueness rule and return a friendly conflict message." }],
        defer: ["Online payments"],
        risks: ["Two customers may request the same time"],
        nextDecision: "Decide whether time slots are fixed or free-form.",
      },
    }, ["project_discovery"]);
    const content = formatEngineeringGuidance({ proposal: response, memory, intents: response.intents });
    expect(content).toContain("## What this product is");
    expect(content).toContain("## How it should work");
    expect(content).toContain("## My recommendation");
    expect(content).toContain("### 1. Booking request");
    expect(content).toContain("## Suggested screens");
    expect(content).toContain("## Architecture at a glance");
    expect(content).toContain("```mermaid");
    expect(content).toContain("Enforce a database uniqueness rule");
    expect(content.match(/^- /gm)).toBeNull();
    expect(content.length).toBeGreaterThan(2_000);
  });

  it("composes compact canonical context without the complete transcript", () => {
    const context = composeConversationContext({ memory, intents: ["project_question"], currentMessage: "Who uses this?", recentMessages: Array.from({ length: 20 }, (_, index) => ({ id: String(index), projectId: project.id, sessionId: session.id, role: index % 2 ? "assistant" as const : "user" as const, content: `message ${index}`, source: "text" as const, createdAt: now })) });
    expect(context.length).toBeLessThanOrEqual(conversationContextLimit);
    expect(context).toContain("CANONICAL PROJECT MEMORY");
    expect(context).toContain("message 19");
    expect(context).not.toContain("message 0");
  });
});
