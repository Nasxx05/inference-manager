import type {
  AcceptanceCriterion,
  ProjectMemory,
  Requirement,
  RequirementArea,
  RequirementPriority,
  RequirementStatus,
  RequirementType,
} from "@/types/project";
import { createRequirement, upsertRequirement } from "./requirements";

const TYPES = new Set<RequirementType>(["business", "functional", "non_functional", "design", "technical", "data", "security", "integration", "acceptance"]);
const PRIORITIES = new Set<RequirementPriority>(["critical", "high", "medium", "low"]);
const CONFIDENCE = new Set(["low", "medium", "high"] as const);
const AREAS = new Set<RequirementArea>(["purpose", "users", "core_functionality", "workflows", "data", "integrations", "interfaces", "security", "performance", "accessibility", "deployment", "constraints", "acceptance_criteria"]);

export interface ValidatedInterviewProposal {
  requirements: Requirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  users: string[];
  designPreferences: string[];
  technicalConstraints: string[];
  assumptions: string[];
  resolvedQuestionAreas: string[];
  newOpenQuestions: string[];
  possibleContradictions: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 1200): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strings(value: unknown, limit = 20, max = 600): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(typeof item === "string" ? item : record(item).description, max)).filter(Boolean))].slice(0, limit);
}

function stem(word: string): string {
  const aliases: Record<string, string> = { customers: "user", customer: "user", users: "user", reservations: "reserve", reservation: "reserve", bookings: "reserve", booking: "reserve", tables: "table", creates: "create", accounts: "account", confirms: "confirm", confirmation: "confirm" };
  const aliased = aliases[word] ?? word;
  return aliased.length > 5 ? aliased.replace(/(ing|ed|es|s)$/, "") : aliased;
}

export function normalizedRequirementDescription(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 2 && !["should", "shall", "must", "able", "allow", "system", "the", "and", "for", "with"].includes(word)).map(stem).join(" ");
}

function similarity(left: string, right: string): number {
  const a = new Set(normalizedRequirementDescription(left).split(" ").filter(Boolean));
  const b = new Set(normalizedRequirementDescription(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / Math.min(a.size, b.size);
}

function matchingRequirement(requirements: Requirement[], description: string): Requirement | undefined {
  const normalized = normalizedRequirementDescription(description);
  return requirements.find((item) => normalizedRequirementDescription(item.description) === normalized)
    ?? requirements.map((item) => ({ item, score: similarity(item.description, description) })).filter(({ score }) => score >= 0.72).sort((a, b) => b.score - a.score)[0]?.item;
}

function subjectOf(value: string): string {
  const match = /^((?:the\s+)?(?:customers?|users?|admins?|administrators?|system|application|visitors?|staff|owners?))\b/i.exec(value.trim());
  return match?.[1] ?? "The system";
}

/** Bounded fallback when the provider omits structured requirements. */
export function splitAtomicRequirements(value: string): string[] {
  const clean = text(value, 8000);
  if (!clean) return [];
  const subject = subjectOf(clean);
  const pieces = clean.split(/\s*(?:,|;|\band\b)\s*/i).map((item) => item.replace(/^[.\s]+|[.\s]+$/g, "")).filter(Boolean);
  if (pieces.length <= 1) return [clean];
  return pieces.map((piece, index) => index === 0 || /^(?:the\s+)?(?:customers?|users?|admins?|administrators?|system|application|visitors?|staff|owners?)\b/i.test(piece) ? piece : `${subject} ${piece}`).map((item) => item[0]!.toUpperCase() + item.slice(1)).slice(0, 20);
}

function explicitEvidence(evidence: string, userContent: string): boolean {
  const needle = normalizedRequirementDescription(evidence);
  const haystack = normalizedRequirementDescription(userContent);
  if (!needle || !haystack) return false;
  const words = needle.split(" ");
  return words.length >= 2 && words.filter((word) => haystack.includes(word)).length / words.length >= 0.8;
}

function acceptanceId(projectId: string, requirementId: string, description: string): string {
  let hash = 2166136261;
  for (const character of `${projectId}:${requirementId}:${normalizedRequirementDescription(description)}`) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `ac_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function criterionExpandsScope(description: string, requirement: string, userContent: string): boolean {
  const combined = `${requirement} ${userContent}`.toLowerCase();
  return [/(pay|payment|checkout|card)/i, /(review|rating)/i, /(loyalty|reward|points)/i, /(subscription|billing)/i]
    .some((pattern) => pattern.test(description) && !pattern.test(combined));
}

export function structuredAcceptanceCriteria(memory: Pick<ProjectMemory, "projectId" | "acceptanceCriteria" | "requirements">, now = new Date().toISOString()): AcceptanceCriterion[] {
  const firstRequirement = memory.requirements.find((item) => item.status !== "rejected" && item.status !== "superseded");
  return memory.acceptanceCriteria.flatMap((item, index) => {
    if (typeof item !== "string") return [{ ...item, projectId: item.projectId || memory.projectId }];
    const description = text(item);
    if (!description || !firstRequirement) return [];
    return [{ id: acceptanceId(memory.projectId, firstRequirement.id, `${index}:${description}`), projectId: memory.projectId, requirementId: firstRequirement.id, description, source: "system" as const, status: "confirmed" as const, confidence: "medium" as const, version: 1, createdAt: now, updatedAt: now }];
  });
}

export function validateInterviewProposal(input: { raw: unknown; memory: ProjectMemory; userContent: string; sourceMessageId: string; now: string }): ValidatedInterviewProposal {
  const root = record(input.raw);
  const rawRequirements = Array.isArray(root.requirements) ? root.requirements : [];
  const proposedDescriptions = rawRequirements.flatMap((item) => {
    const value = record(item);
    const description = text(value.description);
    return description ? splitAtomicRequirements(description) : [];
  });
  const descriptions = proposedDescriptions.length ? proposedDescriptions : splitAtomicRequirements(input.userContent);
  let requirements = [...input.memory.requirements];
  const accepted: Requirement[] = [];

  for (const description of descriptions.slice(0, 24)) {
    if (!description || description.length > 1200) continue;
    const rawItem = rawRequirements.map(record).find((candidate) => text(candidate.description) === description) ?? record(rawRequirements[accepted.length]);
    const evidence = text(rawItem.sourceEvidence ?? rawItem.evidence);
    const userConfirmed = explicitEvidence(evidence || description, input.userContent);
    const existing = requirements.find((item) => item.id === text(rawItem.requirementId, 160)) ?? matchingRequirement(requirements, description);
    const type = TYPES.has(rawItem.type as RequirementType) ? rawItem.type as RequirementType : "functional";
    const categoryValue = text(rawItem.category, 80);
    const category = AREAS.has(categoryValue as RequirementArea) ? categoryValue : "core_functionality";
    const priority = PRIORITIES.has(rawItem.priority as RequirementPriority) ? rawItem.priority as RequirementPriority : "medium";
    const confidence = userConfirmed ? "high" : CONFIDENCE.has(rawItem.confidence as "low" | "medium" | "high") ? rawItem.confidence as "low" | "medium" | "high" : "medium";
    const status: RequirementStatus = userConfirmed ? "confirmed" : "proposed";
    const incoming = createRequirement({ projectId: input.memory.projectId, description, type, category, priority, required: userConfirmed ? true : rawItem.required !== false, source: userConfirmed ? "user" : "ai_inferred", sourceMessageId: input.sourceMessageId, status, confidence, dependencies: strings(rawItem.dependencies, 12, 120), now: input.now });
    const candidate = existing ? { ...incoming, id: existing.id, createdAt: existing.createdAt, version: existing.version + (normalizedRequirementDescription(existing.description) === normalizedRequirementDescription(description) ? 0 : 1) } : incoming;
    requirements = upsertRequirement(requirements, candidate);
    accepted.push(requirements.find((item) => item.id === candidate.id)!);
  }

  const criteria = structuredAcceptanceCriteria({ ...input.memory, requirements });
  const rawCriteria = Array.isArray(root.acceptanceCriteria) ? root.acceptanceCriteria : [];
  for (const item of rawCriteria.slice(0, 48)) {
    const value = record(item);
    const description = text(value.description, 800);
    if (!description) continue;
    const requirement = requirements.find((candidate) => candidate.id === text(value.requirementId, 120))
      ?? matchingRequirement(accepted, text(value.requirementDescription, 1200))
      ?? accepted.find((candidate) => similarity(candidate.description, description) >= 0.25);
    if (!requirement || criterionExpandsScope(description, requirement.description, input.userContent)) continue;
    const evidence = text(value.sourceEvidence ?? value.evidence);
    const userConfirmed = explicitEvidence(evidence, input.userContent);
    const id = acceptanceId(input.memory.projectId, requirement.id, description);
    const existing = criteria.find((criterion) => criterion.id === id || (criterion.requirementId === requirement.id && similarity(criterion.description, description) >= 0.8));
    const criterion: AcceptanceCriterion = { id: existing?.id ?? id, projectId: input.memory.projectId, requirementId: requirement.id, description, source: userConfirmed ? "user" : "ai_inferred", ...(userConfirmed ? { sourceMessageId: input.sourceMessageId } : {}), status: userConfirmed ? "confirmed" : "proposed", confidence: userConfirmed ? "high" : CONFIDENCE.has(value.confidence as "low" | "medium" | "high") ? value.confidence as "low" | "medium" | "high" : "medium", version: existing ? existing.version + (existing.description === description ? 0 : 1) : 1, createdAt: existing?.createdAt ?? input.now, updatedAt: input.now };
    if (existing) criteria.splice(criteria.indexOf(existing), 1, criterion); else criteria.push(criterion);
  }

  return {
    requirements,
    acceptanceCriteria: criteria,
    users: strings(root.users),
    designPreferences: strings(root.designPreferences),
    technicalConstraints: strings(root.technicalConstraints),
    assumptions: strings(root.assumptions),
    resolvedQuestionAreas: strings(root.resolvedQuestionAreas, 20, 80),
    newOpenQuestions: strings(root.newOpenQuestions),
    possibleContradictions: strings(root.possibleContradictions),
  };
}
