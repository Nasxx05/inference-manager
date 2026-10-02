import type { ArtifactType, BriefRequirementPatch, ConversationIntent, ProjectAction, ProjectBriefPatch, PromgentResponseProposal } from "@/types/conversation";

const artifactTypes = new Set<ArtifactType>(["project_blueprint", "technical_blueprint", "architecture", "implementation_plan", "implementation_prompt", "correction_prompt", "enhancement_prompt", "test_plan", "srs", "requirements_snapshot", "data_model", "api_plan", "deployment_plan", "repository_review", "live_product_review", "cost_estimate"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max = 8000): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function strings(value: unknown, limit = 8, max = 800): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => text(item, max)).filter(Boolean))].slice(0, limit)
    : [];
}

function objects<T>(value: unknown, limit: number, parse: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(record).map(parse).filter((item): item is T => item !== null).slice(0, limit);
}

function listPatch(value: unknown): { add: string[]; remove: string[] } | undefined {
  const item = record(value);
  const add = strings(item.add, 20, 800);
  const remove = strings(item.remove, 20, 800);
  return add.length || remove.length ? { add, remove } : undefined;
}

function briefPatch(value: unknown): ProjectBriefPatch | undefined {
  const root = record(value);
  if (!Object.keys(root).length) return undefined;
  const features = objects(root.features, 30, (item): BriefRequirementPatch | null => {
    const action = text(item.action, 20);
    if (!(["add", "change", "remove"] as string[]).includes(action)) return null;
    const description = text(item.description, 1200);
    const requirementId = text(item.requirementId, 160);
    const previousDescription = text(item.previousDescription, 1200);
    if (action === "add" && !description) return null;
    if (action !== "add" && !requirementId && !previousDescription && !description) return null;
    const type = text(item.type, 40) as BriefRequirementPatch["type"];
    const priority = text(item.priority, 20) as BriefRequirementPatch["priority"];
    return {
      action: action as BriefRequirementPatch["action"],
      ...(requirementId ? { requirementId } : {}),
      ...(previousDescription ? { previousDescription } : {}),
      ...(description ? { description } : {}),
      ...(["business", "functional", "non_functional", "design", "technical", "data", "security", "integration", "acceptance"].includes(type ?? "") ? { type } : {}),
      ...(text(item.category, 80) ? { category: text(item.category, 80) } : {}),
      ...(["critical", "high", "medium", "low"].includes(priority ?? "") ? { priority } : {}),
      ...(typeof item.required === "boolean" ? { required: item.required } : {}),
      ...(text(item.reason, 500) ? { reason: text(item.reason, 500) } : {}),
    };
  });
  const decisionsRoot = record(root.decisions);
  const decisionAdd = objects(decisionsRoot.add, 20, (item) => {
    const decision = text(item.decision, 1200);
    return decision ? { decision, reason: text(item.reason, 1200) } : null;
  });
  const questionsRoot = record(root.openQuestions);
  const architectureRoot = record(root.architecture);
  const patch: ProjectBriefPatch = {
    ...(text(root.goal, 2400) ? { goal: text(root.goal, 2400) } : {}),
    ...(listPatch(root.targetUsers) ? { targetUsers: listPatch(root.targetUsers) } : {}),
    ...(features.length ? { features } : {}),
    ...(listPatch(root.techChoices) ? { techChoices: listPatch(root.techChoices) } : {}),
    ...(listPatch(root.constraints) ? { constraints: listPatch(root.constraints) } : {}),
    ...(decisionAdd.length || strings(decisionsRoot.remove, 20, 1200).length ? { decisions: { add: decisionAdd, remove: strings(decisionsRoot.remove, 20, 1200) } } : {}),
    ...(strings(questionsRoot.add, 20, 1200).length || strings(questionsRoot.resolve, 20, 1200).length ? { openQuestions: { add: strings(questionsRoot.add, 20, 1200), resolve: strings(questionsRoot.resolve, 20, 1200) } } : {}),
    ...(typeof architectureRoot.changed === "boolean" ? { architecture: { changed: architectureRoot.changed, ...(text(architectureRoot.summary, 2400) ? { summary: text(architectureRoot.summary, 2400) } : {}), ...(text(architectureRoot.reason, 500) ? { reason: text(architectureRoot.reason, 500) } : {}), ...(text(architectureRoot.diagram, 12_000) ? { diagram: text(architectureRoot.diagram, 12_000) } : {}) } } : {}),
  };
  return Object.keys(patch).length ? patch : undefined;
}

export function validatePromgentResponse(raw: unknown, routedIntents: ConversationIntent[]): PromgentResponseProposal {
  const root = record(raw);
  const message = text(root.message ?? root.assistantMessage, 8000);
  if (!message) throw new Error("Promgent returned no conversational response.");
  const rawArtifacts = Array.isArray(root.artifactRequests) ? root.artifactRequests : [];
  const rawActions = Array.isArray(root.suggestedActions) ? root.suggestedActions : [];
  const guidance = record(root.guidance);
  const overview = text(guidance.overview, 4000);
  const assessment = text(guidance.assessment, 2400) || overview;
  const recommendation = text(guidance.recommendation, 2400);
  const features = objects(guidance.features, 8, (item) => {
    const name = text(item.name, 160); const explanation = text(item.explanation, 1600);
    return name && explanation ? { name, explanation, ...(text(item.whyItMatters, 800) ? { whyItMatters: text(item.whyItMatters, 800) } : {}) } : null;
  });
  const stack = objects(guidance.stack, 8, (item) => {
    const technology = text(item.technology, 160); const purpose = text(item.purpose, 800); const reason = text(item.reason, 1200);
    return technology && purpose && reason ? { technology, purpose, reason } : null;
  });
  const userJourney = objects(guidance.userJourney, 8, (item) => {
    const step = text(item.step, 160); const explanation = text(item.explanation, 1400);
    return step && explanation ? { step, explanation } : null;
  });
  const screens = objects(guidance.screens, 6, (item) => {
    const name = text(item.name, 160); const purpose = text(item.purpose, 1200);
    return name && purpose ? { name, purpose, keyElements: strings(item.keyElements, 8, 240) } : null;
  });
  const riskMitigations = objects(guidance.riskMitigations, 6, (item) => {
    const risk = text(item.risk, 1000); const mitigation = text(item.mitigation, 1200);
    return risk && mitigation ? { risk, mitigation } : null;
  });
  return {
    message,
    intents: routedIntents,
    ...(assessment && recommendation ? {
      guidance: {
        assessment,
        recommendation,
        rationale: strings(guidance.rationale),
        mvpNow: strings(guidance.mvpNow),
        defer: strings(guidance.defer),
        risks: strings(guidance.risks),
        ...(overview ? { overview } : {}),
        ...(text(guidance.productBehavior, 4000) ? { productBehavior: text(guidance.productBehavior, 4000) } : {}),
        ...(text(guidance.technicalApproach, 4000) ? { technicalApproach: text(guidance.technicalApproach, 4000) } : {}),
        ...(text(guidance.architectureExplanation, 3000) ? { architectureExplanation: text(guidance.architectureExplanation, 3000) } : {}),
        ...(features.length ? { features } : {}),
        ...(stack.length ? { stack } : {}),
        ...(userJourney.length ? { userJourney } : {}),
        ...(screens.length ? { screens } : {}),
        ...(riskMitigations.length ? { riskMitigations } : {}),
        ...(text(guidance.nextDecision, 1200) ? { nextDecision: text(guidance.nextDecision, 1200) } : {}),
      },
    } : {}),
    ...(briefPatch(root.briefPatch ?? root.projectBriefPatch) ? { briefPatch: briefPatch(root.briefPatch ?? root.projectBriefPatch) } : {}),
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
