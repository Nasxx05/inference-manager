import { describe, expect, it } from "vitest";
import { applyConversationTurn } from "@/lib/conversation/conversationTurn";
import { validatePromgentResponse } from "@/lib/conversation/responseContract";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory/intake";
import type { InterviewSession } from "@/types/project";
import { responseSimilarity } from "../server/src/promgentConversation";

const now = "2026-10-02T00:00:00.000Z";
const project = createProjectRecord({ id: "00000000-0000-4000-8000-000000000101", userId: "user", description: "A simple booking product", modelId: "auto", planningDepth: "balanced", budget: 10, now });
const baseMemory = createInitialMemory(project, now);
const session: InterviewSession = { id: "00000000-0000-4000-8000-000000000102", projectId: project.id, planningDepth: "balanced", status: "active", turnCount: 0, createdAt: now, updatedAt: now };

function ids() {
  let value = 200;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

describe("structured project brief patches", () => {
  it("adds, changes, and removes explicit features without treating prose as a requirement", () => {
    const existing = baseMemory.requirements[0]!;
    const removed = baseMemory.requirements[1]!;
    const response = validatePromgentResponse({
      message: "I removed the generic placeholder and added a customer cancellation window. The architecture is unchanged.",
      briefPatch: {
        features: [
          { action: "change", requirementId: existing.id, description: "Customers can request an available appointment time", priority: "critical" },
          { action: "add", description: "Customers can cancel a booking until two hours before it begins", category: "core_functionality", priority: "high" },
          { action: "remove", requirementId: removed.id },
        ],
        architecture: { changed: false },
      },
    }, ["change_request"]);
    const result = applyConversationTurn({ memory: structuredClone(baseMemory), session, content: "Change the booking and remove the placeholder.", source: "text", intents: ["change_request"], response, structuredMemoryProposal: response, now, generateId: ids() });
    expect(result.memory.requirements.find((item) => item.id === existing.id)).toMatchObject({ description: "Customers can request an available appointment time", briefChangeStatus: "changed" });
    expect(result.memory.requirements.find((item) => item.description.includes("cancel a booking"))).toMatchObject({ status: "confirmed", briefChangeStatus: "new" });
    expect(result.memory.requirements.find((item) => item.id === removed.id)).toMatchObject({ status: "rejected", briefChangeStatus: "removed" });
  });

  it("does not synthesize a requirement when a change-classified turn has no patch", () => {
    const response = validatePromgentResponse({ message: "I need more detail before recommending that change." }, ["change_request"]);
    const result = applyConversationTurn({ memory: structuredClone(baseMemory), session, content: "Could we maybe change it?", source: "text", intents: ["change_request"], response, structuredMemoryProposal: {}, now, generateId: ids() });
    expect(result.memory.requirements).toEqual(baseMemory.requirements);
  });
});

describe("response repetition guard", () => {
  it("detects a near-copy while allowing genuinely new analysis", () => {
    const prior = "Customers choose a time, the server checks availability, and the booking is saved before a confirmation appears.";
    expect(responseSimilarity(prior, `${prior} This is the recommended flow.`)).toBeGreaterThan(0.7);
    expect(responseSimilarity(prior, "Use a unique database constraint to stop two customers claiming the same appointment.")).toBeLessThan(0.7);
  });
});
