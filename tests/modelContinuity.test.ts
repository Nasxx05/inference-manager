import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuidedInterviewInference } from "../server/src/guidedInterview";
import { runChangeImpactInference, runIterationPromptInference, runIterationReviewInference, runSuggestionDiscussionInference, runSuggestionScopeInference } from "../server/src/iterationAgent";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";
import { createIteration } from "@/lib/iteration";
import type { ProjectSuggestion } from "@/types/iteration";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.ORBIO_BASE_URL; });

describe("one authoritative project model", () => {
  it("uses Project.selectedModel for interview, review, discussion, impact and prompts", async () => {
    process.env.ORBIO_BASE_URL = "https://orbio.example/v1";
    const seenModels: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as { model?: string; messages?: Array<{ content?: string }> };
      seenModels.push(String(request.model));
      const system = String(request.messages?.[0]?.content ?? "");
      const content = system.includes("requirements-engineering")
        ? JSON.stringify({ assistantMessage: "Who are the users?", requirements: [], acceptanceCriteria: [] })
        : system.includes("senior software Review Agent")
          ? JSON.stringify({ summary: "Evidence reviewed.", traceability: [], technicalFindings: [], suggestions: [] })
          : system.includes("suggestion advisor")
            ? JSON.stringify({ assistantMessage: "This is optional and would reduce manual payment handling." })
            : system.includes("final user-approved scope")
              ? JSON.stringify({ changes: [{ description: "Use Paystack for card payments only." }] })
              : system.includes("change-impact analyst")
                ? JSON.stringify({ requirements: { new: [], modified: [], superseded: [] }, acceptanceCriteria: { new: [], modified: [] }, architectureChanges: [], dataModelChanges: [], integrationChanges: [], securityImplications: [], risks: [], summary: "Payment integration changes the external boundary." })
                : "Inspect the current code first and implement only approved scope.";
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }) } as unknown as Response;
    }));

    const project = createProjectRecord({ id: "project_model", userId: "user_model", description: "Restaurant bookings", modelId: "gpt-4o", planningDepth: "balanced", budget: 10 });
    const memory = createInitialMemory(project);
    const iteration = createIteration({ project, existing: [] });
    const suggestion: ProjectSuggestion = { id: "suggestion_payment", projectId: project.id, iterationId: iteration.id, title: "Online Payments", description: "Offer online payment", rationale: "Optional checkout improvement", expectedBenefit: "Less cash handling", implementationImpact: "high", architectureAffected: true, requirementsAffected: [], confidence: "medium", status: "discussing", createdAt: project.createdAt };
    const discussion = [{ id: "message_1", suggestionId: suggestion.id, iterationId: iteration.id, projectId: project.id, role: "user" as const, content: "Use Paystack and card payments only.", createdAt: project.createdAt }];

    await runGuidedInterviewInference({ apiKey: "user-key", project, memory, userContent: "Customers reserve tables." });
    await runIterationReviewInference({ apiKey: "user-key", project, memory, iteration });
    await runSuggestionDiscussionInference({ apiKey: "user-key", project, memory, suggestion, messages: [], userMessage: "Why?" });
    await runSuggestionScopeInference({ apiKey: "user-key", project, memory, suggestion, messages: discussion });
    await runChangeImpactInference({ apiKey: "user-key", project, memory, changes: ["Use Paystack for card payments only."] });
    await runIterationPromptInference({ apiKey: "user-key", project, draftPrompt: "Approved scope" });

    expect(seenModels).toHaveLength(6);
    expect(new Set(seenModels)).toEqual(new Set(["openai/gpt-4o"]));
  });
});
