import type {
  ProjectMemory,
  Requirement,
  RequirementArea,
  RequirementPriority,
  RequirementSource,
  RequirementStatus,
  RequirementType,
} from "@/types/project";

const TYPE_BY_AREA: Record<string, RequirementType> = {
  purpose: "business",
  users: "business",
  core_functionality: "functional",
  workflows: "functional",
  data: "data",
  integrations: "integration",
  interfaces: "design",
  security: "security",
  performance: "non_functional",
  accessibility: "non_functional",
  deployment: "technical",
  constraints: "technical",
  acceptance_criteria: "acceptance",
};

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function requirementId(projectId: string, description: string): string {
  return `req_${stableHash(`${projectId}:${description.trim().toLowerCase()}`)}`;
}

export function createRequirement(input: {
  projectId: string;
  description: string;
  category: RequirementArea | string;
  type?: RequirementType;
  priority?: RequirementPriority;
  required?: boolean;
  source?: RequirementSource;
  sourceMessageId?: string;
  status?: RequirementStatus;
  confidence?: Requirement["confidence"];
  dependencies?: string[];
  now?: string;
}): Requirement {
  const now = input.now ?? new Date().toISOString();
  const description = input.description.trim();
  return {
    id: requirementId(input.projectId, description),
    projectId: input.projectId,
    type: input.type ?? TYPE_BY_AREA[input.category] ?? "functional",
    category: input.category,
    description,
    priority: input.priority ?? "medium",
    required: input.required ?? true,
    source: input.source ?? "ai_inferred",
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    status: input.status ?? "inferred",
    confidence: input.confidence ?? "medium",
    dependencies: input.dependencies ?? [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertRequirement(
  requirements: Requirement[],
  incoming: Requirement,
): Requirement[] {
  const index = requirements.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...requirements, incoming];

  const existing = requirements[index]!;
  const merged: Requirement = {
    ...existing,
    ...incoming,
    // A user-confirmed statement must never be downgraded by a later inference.
    status:
      existing.status === "confirmed" && incoming.status !== "confirmed"
        ? "confirmed"
        : incoming.status,
    source:
      existing.source === "user" && incoming.source !== "user" ? "user" : incoming.source,
    version: existing.version + 1,
    updatedAt: incoming.updatedAt,
  };
  return requirements.map((item, itemIndex) => (itemIndex === index ? merged : item));
}

export function confirmedRequirements(memory: ProjectMemory): Requirement[] {
  return memory.requirements.filter((item) => item.status === "confirmed");
}

export function activeRequirements(memory: ProjectMemory): Requirement[] {
  return memory.requirements.filter(
    (item) => item.status !== "rejected" && item.status !== "superseded",
  );
}
