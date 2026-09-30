import type { ArtifactType, ConversationIntent, ProjectAction, PromgentResponseProposal } from "@/types/conversation";

const artifactTypes = new Set<ArtifactType>(["project_blueprint", "architecture", "implementation_plan", "implementation_prompt", "correction_prompt", "enhancement_prompt", "test_plan", "srs", "requirements_snapshot", "data_model", "api_plan", "deployment_plan", "repository_review", "live_product_review", "cost_estimate"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max = 8000): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

export function validatePromgentResponse(raw: unknown, routedIntents: ConversationIntent[]): PromgentResponseProposal {
  const root = record(raw);
  const message = text(root.message ?? root.assistantMessage, 8000);
  if (!message) throw new Error("Promgent returned no conversational response.");
  const rawArtifacts = Array.isArray(root.artifactRequests) ? root.artifactRequests : [];
  const rawActions = Array.isArray(root.suggestedActions) ? root.suggestedActions : [];
  return {
    message,
    intents: routedIntents,
    memoryChanges: Array.isArray(root.memoryChanges) ? root.memoryChanges.slice(0, 50) : [],
    decisions: (Array.isArray(root.decisions) ? root.decisions : []).flatMap((item) => {
      const value = record(item); const decision = text(value.decision, 1200); const reason = text(value.reason, 1200);
      return decision ? [{ decision, reason, source: "assistant_proposal" as const, confidence: (["low", "medium", "high"].includes(text(value.confidence)) ? text(value.confidence) : "medium") as "low" | "medium" | "high", status: "proposed" as const }] : [];
    }).slice(0, 12),
    artifactRequests: rawArtifacts.flatMap((item) => {
      const value = record(item); const type = text(value.type) as ArtifactType; const reason = text(value.reason, 500);
      return artifactTypes.has(type) && reason ? [{ type, ...(text(value.title, 160) ? { title: text(value.title, 160) } : {}), reason, ...(text(value.content, 16_000) ? { content: text(value.content, 16_000) } : {}), ...(Object.keys(record(value.structuredData)).length ? { structuredData: record(value.structuredData) } : {}) }] : [];
    }).slice(0, 4),
    suggestedActions: rawActions.flatMap((item, index) => {
      const value = record(item); const label = text(value.label, 120); const type = text(value.type, 80) as ProjectAction["type"];
      return label && type ? [{ id: text(value.id, 120) || `action_${index + 1}`, type, label, ...(record(value.payload) ? { payload: record(value.payload) } : {}) }] : [];
    }).slice(0, 4),
    ...(record(root.nextRecommendedAction).type && record(root.nextRecommendedAction).label ? { nextRecommendedAction: { type: text(record(root.nextRecommendedAction).type, 80), label: text(record(root.nextRecommendedAction).label, 160), reason: text(record(root.nextRecommendedAction).reason, 500) } } : {}),
  };
}
