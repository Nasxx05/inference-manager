import { describe, expect, it } from "vitest";
import { routeConversationIntents } from "@/lib/conversation/intentRouter";
import { composeConversationContext, conversationContextLimit } from "@/lib/conversation/contextComposer";
import { validatePromgentResponse } from "@/lib/conversation/responseContract";
import { applyConversationTurn } from "@/lib/conversation/conversationTurn";
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
    ["Review this implementation against the project brief", "repository_review"],
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

  it("composes compact canonical context without the complete transcript", () => {
    const context = composeConversationContext({ memory, intents: ["project_question"], currentMessage: "Who uses this?", recentMessages: Array.from({ length: 20 }, (_, index) => ({ id: String(index), projectId: project.id, sessionId: session.id, role: index % 2 ? "assistant" as const : "user" as const, content: `message ${index}`, source: "text" as const, createdAt: now })) });
    expect(context.length).toBeLessThanOrEqual(conversationContextLimit);
    expect(context).toContain("CANONICAL PROJECT MEMORY");
    expect(context).toContain("message 18");
    expect(context).not.toContain("message 19");
    expect(context).not.toContain("message 0");
  });
});
