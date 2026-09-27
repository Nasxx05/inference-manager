import type {
  ChangeRequest,
  ChangeRequestCategory,
  IterationReport,
  ProjectIteration,
  ProjectSuggestion,
  ReviewFinding,
  TraceabilityRecord,
} from "@/types/iteration";
import type { ProjectRecord, Requirement } from "@/types/project";

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function categoryFor(text: string): ChangeRequestCategory {
  const lower = text.toLowerCase();
  if (/hero|color|colour|font|layout|visual|design|spacing|image|smaller|larger/.test(lower)) return "visual_change";
  if (/bug|broken|error|fails|doesn't work|not working/.test(lower)) return "bug_report";
  if (/slow|performance|fast|latency/.test(lower)) return "performance_change";
  if (/remove|delete|drop|no longer/.test(lower)) return "feature_removal";
  if (/security|auth|permission|role|admin/.test(lower)) return "technical_change";
  if (/content|copy|wording|text/.test(lower)) return "content_change";
  if (/use|usability|easier|simpler|move|prominent|accessible/.test(lower)) return "usability_change";
  if (/add|new|introduce|support|include|need|want/.test(lower)) return "feature_addition";
  return "feature_change";
}

function splitRequests(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const separated = normalized.replace(/\s+(?=(?:also\s+|and\s+)(?:add|remove|change|move|fix|improve|make|introduce)\b)/gi, "\n");
  const lines = separated.split(/\n+/).map((line) => clean(line.replace(/^and\s+/i, ""))).filter(Boolean);
  if (lines.length > 1) return lines.flatMap((line) => line.split(/(?<=[.!?])\s+/).map(clean).filter(Boolean));
  return normalized.split(/(?<=[.!?])\s+(?=(?:also|and|but|make|add|remove|change|move|fix|improve|customers?|users?\b))/i).map(clean).filter(Boolean);
}

export function extractChangeRequests(input: {
  iterationId: string;
  projectId: string;
  text?: string;
  voiceTranscript?: string;
  now?: string;
}): ChangeRequest[] {
  const sourceText = input.text?.trim() || input.voiceTranscript?.trim() || "";
  const source = input.voiceTranscript?.trim() && !input.text?.trim() ? "voice_transcript" : "user_text";
  const now = input.now ?? new Date().toISOString();
  return splitRequests(sourceText).map((description, index) => ({
    id: `change_${stableHash(`${input.iterationId}:${index}:${description.toLowerCase()}`)}`,
    iterationId: input.iterationId,
    projectId: input.projectId,
    category: categoryFor(description),
    description,
    source,
    priority: /security|payment|admin|auth|bug|critical|must|required/i.test(description) ? "high" : "medium",
    status: "proposed",
    createdAt: now,
  }));
}

export function createIteration(input: {
  project: ProjectRecord;
  existing: ProjectIteration[];
  baseSrsVersionId?: string;
  baseArchitectureVersionId?: string;
  title?: string;
  now?: string;
}): ProjectIteration {
  const now = input.now ?? new Date().toISOString();
  const sequenceNumber = input.existing.reduce((max, item) => Math.max(max, item.sequenceNumber), 0) + 1;
  return {
    id: `iteration_${input.project.id}_${sequenceNumber}`,
    projectId: input.project.id,
    sequenceNumber,
    title: input.title?.trim() || (sequenceNumber === 1 ? "Initial Implementation Review" : `Iteration ${sequenceNumber} Review`),
    status: "collecting_context",
    ...(input.baseSrsVersionId ? { baseSrsVersionId: input.baseSrsVersionId } : {}),
    ...(input.baseArchitectureVersionId ? { baseArchitectureVersionId: input.baseArchitectureVersionId } : {}),
    changeRequests: [],
    findings: [],
    evidence: [],
    traceability: [],
    suggestions: [],
    decisions: [],
    startedAt: now,
    updatedAt: now,
  };
}

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((item) => item.length > 3))];
}

export function buildTraceability(input: {
  iteration: ProjectIteration;
  requirements: Requirement[];
  evidenceText: string;
  hasRepository: boolean;
  now?: string;
}): { traceability: TraceabilityRecord[]; evidence: ProjectIteration["evidence"] } {
  const now = input.now ?? new Date().toISOString();
  const corpus = input.evidenceText.toLowerCase();
  const evidence: ProjectIteration["evidence"] = [];
  const traceability = input.requirements.filter((item) => item.status !== "rejected" && item.status !== "superseded").map((requirement) => {
    const words = terms(requirement.description).slice(0, 12);
    const hits = words.filter((word) => corpus.includes(word));
    const ratio = words.length ? hits.length / words.length : 0;
    const evidenceId = `evidence_${stableHash(`${input.iteration.id}:${requirement.id}`)}`;
    let status: TraceabilityRecord["status"];
    let explanation: string;
    if (!input.hasRepository) {
      status = "cannot_verify";
      explanation = "No repository evidence was provided; source-level implementation cannot be verified.";
    } else if (ratio >= 0.55) {
      status = "satisfied";
      explanation = "Relevant implementation terms were found in the reviewed repository evidence. Runtime behavior remains unverified.";
    } else if (ratio >= 0.2) {
      status = "partially_satisfied";
      explanation = "Some related implementation evidence was found, but coverage is incomplete or ambiguous.";
    } else {
      status = "missing";
      explanation = "No relevant implementation evidence was located in the bounded repository review.";
    }
    if (input.hasRepository) evidence.push({ id: evidenceId, type: "repository_structure", explanation: hits.length ? `Matched terms: ${hits.join(", ")}.` : "No matching terms found.", confidence: ratio >= 0.55 ? "medium" : "low" });
    const confidence: TraceabilityRecord["confidence"] = input.hasRepository ? "medium" : "low";
    return { id: `trace_${input.iteration.id}_${requirement.id}`, iterationId: input.iteration.id, projectId: input.iteration.projectId, requirementId: requirement.id, requirementDescription: requirement.description, status, acceptanceCriteria: [], evidenceIds: input.hasRepository ? [evidenceId] : [], explanation, confidence };
  });
  return { traceability, evidence };
}

export function findingsFromTraceability(input: { iteration: ProjectIteration; traceability: TraceabilityRecord[]; now?: string }): ReviewFinding[] {
  const now = input.now ?? new Date().toISOString();
  return input.traceability.filter((item) => item.status === "missing" || item.status === "partially_satisfied" || item.status === "conflicting").map((item) => ({
    id: `finding_${stableHash(`${input.iteration.id}:${item.requirementId}:${item.status}`)}`,
    iterationId: input.iteration.id,
    projectId: input.iteration.projectId,
    type: "required_fix",
    severity: item.status === "missing" ? "high" : "medium",
    title: `${item.status === "missing" ? "Missing" : "Partial"} requirement: ${item.requirementDescription.slice(0, 100)}`,
    description: item.explanation,
    plainLanguage: item.status === "missing" ? "This agreed capability was not found in the reviewed source evidence." : "Part of this agreed capability may exist, but the review could not confirm the complete workflow.",
    requirementIds: [item.requirementId],
    acceptanceCriteriaIds: [],
    evidenceIds: item.evidenceIds,
    confidence: item.confidence,
    impact: "The approved project state may not be fully implemented.",
    implementationComplexity: item.status === "missing" ? "medium" : "low",
    architectureAffected: false,
    specificationAffected: false,
    status: "open",
    createdAt: now,
  }));
}

export function technicalFindings(input: { iteration: ProjectIteration; evidenceText: string; now?: string }): ReviewFinding[] {
  const lower = input.evidenceText.toLowerCase();
  const now = input.now ?? new Date().toISOString();
  const findings: ReviewFinding[] = [];
  const add = (key: string, title: string, description: string, plainLanguage: string, severity: ReviewFinding["severity"]) => findings.push({ id: `finding_${stableHash(`${input.iteration.id}:${key}`)}`, iterationId: input.iteration.id, projectId: input.iteration.projectId, type: "technical_concern", severity, title, description, plainLanguage, requirementIds: [], acceptanceCriteriaIds: [], evidenceIds: [], confidence: "medium", impact: "May affect reliability or safe maintenance of the project.", implementationComplexity: severity === "high" ? "medium" : "low", architectureAffected: false, specificationAffected: false, status: "open", createdAt: now });
  if (/dangerouslysetinnerhtml|eval\s*\(/.test(lower)) add("unsafe_code", "Potentially unsafe dynamic code or HTML", "The repository contains a pattern that deserves an explicit safety review.", "Some content may be executed or rendered without enough safety checks.", "high");
  if (/admin|management/.test(lower) && !/middleware|authorize|isadmin|role/.test(lower)) add("admin_auth", "Administrative route authorization needs verification", "Administrative concepts were found without an obvious authorization signal in the bounded evidence.", "A normal user might reach an action intended only for administrators.", "high");
  if (/password|secret|api[_-]?key|private key/.test(lower) && !/redacted/.test(lower)) add("credential_signal", "Potential credential-like content requires review", "Credential-like names were found in the repository evidence; values are not retained by this review.", "A key or password may be present in code or configuration and should be moved to secure environment storage.", "high");
  return findings;
}

export function suggestionsForProject(input: { iteration: ProjectIteration; projectType: string; memoryText: string; existingTitles?: string[]; now?: string }): ProjectSuggestion[] {
  const lower = `${input.projectType} ${input.memoryText}`.toLowerCase();
  const blocked = new Set((input.existingTitles ?? []).map((item) => item.toLowerCase()));
  const candidates: Array<Omit<ProjectSuggestion, "id" | "createdAt" | "iterationId" | "projectId" | "status">> = [];
  if (/booking|reservation|appointment/.test(lower) && !/availability|calendar/.test(lower)) candidates.push({ title: "Availability Calendar", description: "Show availability before the user enters the full booking flow.", rationale: "The project appears to depend on reservations, but availability is not yet represented in the approved workflow.", expectedBenefit: "Fewer failed booking attempts and clearer user decisions.", implementationImpact: "medium", architectureAffected: true, requirementsAffected: [], confidence: "medium" });
  if (/order|restaurant|delivery/.test(lower) && /pay on delivery|cash on delivery/.test(lower) && !/online payment/.test(lower)) candidates.push({ title: "Online Payments", description: "Allow customers to pay before an order is fulfilled.", rationale: "The current workflow appears to defer payment until delivery, which may create manual confirmation work.", expectedBenefit: "Faster checkout confirmation and less payment handling at delivery.", implementationImpact: "high", architectureAffected: true, requirementsAffected: [], confidence: "medium" });
  if (/account|customer|user|admin/.test(lower) && !/audit|activity history/.test(lower)) candidates.push({ title: "Activity History", description: "Give users or operators a clear history of important project actions.", rationale: "The project contains state-changing workflows where a history could improve support and accountability.", expectedBenefit: "Easier troubleshooting and clearer ownership of changes.", implementationImpact: "medium", architectureAffected: true, requirementsAffected: [], confidence: "low" });
  return candidates.filter((item) => !blocked.has(item.title.toLowerCase())).slice(0, 3).map((item, index) => ({ ...item, id: `suggestion_${stableHash(`${input.iteration.id}:${index}:${item.title}`)}`, projectId: input.iteration.projectId, iterationId: input.iteration.id, status: "proposed", createdAt: input.now ?? new Date().toISOString() }));
}

export function summarizeIteration(input: { traceability: TraceabilityRecord[]; findings: ReviewFinding[]; suggestions: ProjectSuggestion[] }): IterationReport {
  const count = (status: TraceabilityRecord["status"]) => input.traceability.filter((item) => item.status === status).length;
  return {
    requirementsReviewed: input.traceability.length,
    satisfied: count("satisfied"),
    partial: count("partially_satisfied"),
    missing: count("missing"),
    conflicting: count("conflicting"),
    cannotVerify: count("cannot_verify"),
    requiredFixes: input.findings.filter((item) => item.type === "required_fix").length,
    technicalConcerns: input.findings.filter((item) => item.type === "technical_concern").length,
    userChanges: input.findings.filter((item) => item.type === "user_change").length,
    optionalSuggestions: input.suggestions.length,
    summary: `${count("satisfied")} satisfied, ${count("partially_satisfied")} partial, ${count("missing")} missing, and ${count("cannot_verify")} unable to verify from the supplied evidence.`,
  };
}
