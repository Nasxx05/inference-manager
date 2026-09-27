import type { AcceptanceCriterion, ProjectMemory, Requirement } from "@/types/project";
import type { ProjectIteration, ProjectSuggestion, ReviewEvidence, ReviewFinding, TraceabilityRecord, TraceabilityStatus } from "@/types/iteration";
import { structuredAcceptanceCriteria } from "@/lib/projectMemory/proposals";

const STATUSES = new Set<TraceabilityStatus>(["satisfied", "partially_satisfied", "missing", "conflicting", "cannot_verify"]);
const CONFIDENCE = new Set(["low", "medium", "high"] as const);
const SEVERITIES = new Set(["low", "medium", "high", "critical"] as const);
const IMPACTS = new Set(["low", "medium", "high"] as const);
const CATEGORIES = new Set(["security", "reliability", "performance", "accessibility", "maintainability", "architecture", "error_handling", "configuration"] as const);

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, max = 2000): string { return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : ""; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function hash(value: string): string { let result = 2166136261; for (const character of value) { result ^= character.charCodeAt(0); result = Math.imul(result, 16777619); } return (result >>> 0).toString(16).padStart(8, "0"); }

function status(value: unknown): TraceabilityStatus { return STATUSES.has(value as TraceabilityStatus) ? value as TraceabilityStatus : "cannot_verify"; }
function confidence(value: unknown): "low" | "medium" | "high" { return CONFIDENCE.has(value as "low" | "medium" | "high") ? value as "low" | "medium" | "high" : "low"; }

function evidenceFrom(input: { raw: unknown; iteration: ProjectIteration; allowedFiles: Set<string>; liveReviewed: boolean; evidence: ReviewEvidence[] }): string[] {
  const ids: string[] = [];
  for (const item of array(input.raw).slice(0, 12)) {
    const value = object(item);
    const type = text(value.type, 40);
    const file = text(value.file ?? value.repositoryFile, 500);
    const explanation = text(value.explanation, 1000);
    if (!explanation) continue;
    if (type === "repository_file") {
      if (!file || !input.allowedFiles.has(file)) continue;
      const id = `evidence_${hash(`${input.iteration.id}:file:${file}:${explanation}`)}`;
      if (!input.evidence.some((existing) => existing.id === id)) input.evidence.push({ id, type: "repository_file", repositoryFile: file, explanation, confidence: confidence(value.confidence), verification: "source" });
      ids.push(id);
    } else if ((type === "live_url" || type === "live_product") && input.liveReviewed) {
      const id = `evidence_${hash(`${input.iteration.id}:live:${explanation}`)}`;
      if (!input.evidence.some((existing) => existing.id === id)) input.evidence.push({ id, type: "live_url", liveUrl: input.iteration.liveProductSnapshot?.url, explanation, confidence: confidence(value.confidence), verification: "live" });
      ids.push(id);
    } else if (type === "screenshot") {
      const screenshotId = text(value.screenshotId, 200);
      if (!screenshotId || !input.iteration.screenshotArtifacts?.some((item) => item.id === screenshotId)) continue;
      const id = `evidence_${hash(`${input.iteration.id}:screenshot:${screenshotId}:${explanation}`)}`;
      if (!input.evidence.some((existing) => existing.id === id)) input.evidence.push({ id, type: "screenshot", explanation, confidence: confidence(value.confidence), verification: "live" });
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

function criterionStatus(rawStatus: TraceabilityStatus, runtimeRequired: boolean, liveReviewed: boolean): TraceabilityStatus {
  return rawStatus === "satisfied" && runtimeRequired && !liveReviewed ? "cannot_verify" : rawStatus;
}

export function deriveRequirementStatus(criteria: TraceabilityRecord["acceptanceCriteria"], modelStatus: TraceabilityStatus): TraceabilityStatus {
  if (!criteria.length) return modelStatus;
  const values = criteria.map((item) => item.status);
  if (values.includes("conflicting")) return "conflicting";
  if (values.every((value) => value === "satisfied")) return modelStatus === "missing" || modelStatus === "conflicting" ? "partially_satisfied" : "satisfied";
  if (values.every((value) => value === "missing")) return "missing";
  if (values.every((value) => value === "cannot_verify")) return modelStatus === "missing" ? "missing" : "cannot_verify";
  return "partially_satisfied";
}

export interface SemanticReviewResult {
  summary: string;
  traceability: TraceabilityRecord[];
  evidence: ReviewEvidence[];
  findings: ReviewFinding[];
  suggestions: ProjectSuggestion[];
}

export function validateSemanticReview(input: { raw: unknown; iteration: ProjectIteration; memory: ProjectMemory; previousSuggestions?: ProjectSuggestion[]; now?: string }): SemanticReviewResult {
  const root = object(input.raw);
  const now = input.now ?? new Date().toISOString();
  const requirements = input.memory.requirements.filter((item) => item.status !== "rejected" && item.status !== "superseded");
  const requirementById = new Map(requirements.map((item) => [item.id, item]));
  const criteria = structuredAcceptanceCriteria(input.memory);
  const criterionById = new Map(criteria.map((item) => [item.id, item]));
  const allowedFiles = new Set(input.iteration.repositorySnapshot?.relevantFiles ?? []);
  const liveReviewed = input.iteration.liveProductSnapshot?.status === "reviewed";
  const evidence: ReviewEvidence[] = [];
  const traceability: TraceabilityRecord[] = [];

  for (const item of array(root.traceability).slice(0, Math.max(100, requirements.length))) {
    const value = object(item);
    const requirement = requirementById.get(text(value.requirementId, 160));
    if (!requirement) continue;
    const evidenceIds = evidenceFrom({ raw: value.evidence, iteration: input.iteration, allowedFiles, liveReviewed, evidence });
    const criterionTraces = array(value.acceptanceCriteria).flatMap((criterionRaw) => {
      const criterionValue = object(criterionRaw);
      const criterion = criterionById.get(text(criterionValue.criterionId, 160));
      if (!criterion || criterion.requirementId !== requirement.id) return [];
      const criterionEvidence = evidenceFrom({ raw: criterionValue.evidence, iteration: input.iteration, allowedFiles, liveReviewed, evidence });
      const runtimeRequired = criterionValue.runtimeVerificationRequired === true;
      const reviewedStatus = criterionStatus(status(criterionValue.status), runtimeRequired, liveReviewed);
      const explanation = text(criterionValue.reason ?? criterionValue.explanation) || (reviewedStatus === "cannot_verify" ? "Source evidence exists, but this behavior requires runtime verification." : "No reliable explanation was returned.");
      return [{ criterionId: criterion.id, description: criterion.description, status: reviewedStatus, evidenceIds: criterionEvidence, explanation, confidence: confidence(criterionValue.confidence) }];
    });
    const modelStatus = status(value.status);
    const finalStatus = deriveRequirementStatus(criterionTraces, modelStatus);
    const runtime = value.runtimeVerificationRequired === true && !liveReviewed;
    const reason = text(value.reason ?? value.explanation) || "The model returned no reliable explanation.";
    traceability.push({ id: `trace_${input.iteration.id}_${requirement.id}`, iterationId: input.iteration.id, projectId: input.iteration.projectId, requirementId: requirement.id, requirementDescription: requirement.description, status: finalStatus, acceptanceCriteria: criterionTraces, evidenceIds, explanation: runtime ? `${reason} Source implementation was reviewed; runtime behavior was not observed.` : reason, confidence: confidence(value.confidence) });
  }

  for (const requirement of requirements) {
    if (traceability.some((item) => item.requirementId === requirement.id)) continue;
    traceability.push({ id: `trace_${input.iteration.id}_${requirement.id}`, iterationId: input.iteration.id, projectId: input.iteration.projectId, requirementId: requirement.id, requirementDescription: requirement.description, status: "cannot_verify", acceptanceCriteria: criteria.filter((criterion) => criterion.requirementId === requirement.id).map((criterion) => ({ criterionId: criterion.id, description: criterion.description, status: "cannot_verify", evidenceIds: [], explanation: "The semantic review did not return a valid evaluation for this criterion.", confidence: "low" })), evidenceIds: [], explanation: "The semantic review did not return a valid evaluation for this requirement.", confidence: "low" });
  }

  const findings: ReviewFinding[] = [];
  for (const item of array(root.technicalFindings).slice(0, 20)) {
    const value = object(item);
    const title = text(value.title, 180); const description = text(value.description); const plainLanguage = text(value.plainLanguage ?? value.plainLanguageExplanation);
    const evidenceIds = evidenceFrom({ raw: value.evidence, iteration: input.iteration, allowedFiles, liveReviewed, evidence });
    if (!title || !description || !plainLanguage || !evidenceIds.length) continue;
    const category = CATEGORIES.has(value.category as never) ? value.category as ReviewFinding["category"] : "maintainability";
    const severity = SEVERITIES.has(value.severity as never) ? value.severity as ReviewFinding["severity"] : "medium";
    findings.push({ id: `finding_${hash(`${input.iteration.id}:technical:${title}`)}`, iterationId: input.iteration.id, projectId: input.iteration.projectId, type: "technical_concern", category, severity, title, description, plainLanguage, requirementIds: array(value.requirementIds).map(String).filter((id) => requirementById.has(id)).slice(0, 20), acceptanceCriteriaIds: array(value.acceptanceCriteriaIds).map(String).filter((id) => criterionById.has(id)).slice(0, 30), evidenceIds, confidence: confidence(value.confidence), impact: text(value.likelyImpact ?? value.impact) || "The concern may affect the project's reliability or maintainability.", recommendedDirection: text(value.recommendedDirection), implementationComplexity: IMPACTS.has(value.implementationImpact as never) ? value.implementationImpact as "low" | "medium" | "high" : "medium", architectureAffected: value.architectureAffected === true || category === "architecture", specificationAffected: value.specificationAffected === true, status: "open", createdAt: now });
  }

  const prior = input.previousSuggestions ?? [];
  const blockedTitles = new Set(prior.filter((item) => item.status === "rejected" || item.status === "deferred" || item.status === "accepted").map((item) => item.title.toLowerCase()));
  const activeDescriptions = requirements.map((item) => item.description.toLowerCase()).join(" ");
  const suggestions: ProjectSuggestion[] = [];
  for (const item of array(root.suggestions).slice(0, 5)) {
    const value = object(item); const title = text(value.title, 160); const description = text(value.description); const rationale = text(value.rationale); const expectedBenefit = text(value.expectedBenefit);
    if (!title || !description || !rationale || !expectedBenefit || blockedTitles.has(title.toLowerCase())) continue;
    if (activeDescriptions.includes(title.toLowerCase())) continue;
    suggestions.push({ id: `suggestion_${hash(`${input.iteration.id}:${title}`)}`, projectId: input.iteration.projectId, iterationId: input.iteration.id, title, description, rationale, expectedBenefit, implementationImpact: IMPACTS.has(value.implementationImpact as never) ? value.implementationImpact as "low" | "medium" | "high" : "medium", architectureAffected: value.architectureAffected === true, requirementsAffected: array(value.requirementsAffected).map(String).filter((id) => requirementById.has(id)).slice(0, 20), confidence: confidence(value.confidence), status: "proposed", createdAt: now });
  }

  return { summary: text(root.summary, 2500), traceability, evidence, findings, suggestions };
}

export function reviewContext(memory: ProjectMemory): { requirements: Array<Pick<Requirement, "id" | "description" | "status">>; acceptanceCriteria: Array<Pick<AcceptanceCriterion, "id" | "requirementId" | "description" | "status">> } {
  return { requirements: memory.requirements.map(({ id, description, status }) => ({ id, description, status })), acceptanceCriteria: structuredAcceptanceCriteria(memory).map(({ id, requirementId, description, status }) => ({ id, requirementId, description, status })) };
}
