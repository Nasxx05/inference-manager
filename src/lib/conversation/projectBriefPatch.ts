import { createUuid } from "@/lib/ids";
import { createRequirement } from "@/lib/projectMemory/requirements";
import type { ProjectBriefPatch } from "@/types/conversation";
import type { ProjectMemory, Requirement } from "@/types/project";

function key(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function updateList(current: string[] | undefined, add: string[] = [], remove: string[] = []): string[] {
  const removed = new Set(remove.map(key));
  const output = (current ?? []).filter((item) => !removed.has(key(item)));
  const known = new Set(output.map(key));
  for (const item of add) {
    if (!known.has(key(item))) {
      output.push(item.trim());
      known.add(key(item));
    }
  }
  return output;
}

function sameList(left: string[] | undefined, right: string[] | undefined): boolean {
  return (left ?? []).length === (right ?? []).length && (left ?? []).every((item, index) => key(item) === key((right ?? [])[index] ?? ""));
}

function findRequirement(requirements: Requirement[], patch: NonNullable<ProjectBriefPatch["features"]>[number]): number {
  if (patch.requirementId) {
    const index = requirements.findIndex((item) => item.id === patch.requirementId);
    if (index >= 0) return index;
  }
  const description = patch.previousDescription || (patch.action !== "add" ? patch.description : "");
  return description ? requirements.findIndex((item) => key(item.description) === key(description)) : -1;
}

export function applyProjectBriefPatch(input: {
  memory: ProjectMemory;
  patch: ProjectBriefPatch;
  sourceMessageId: string;
  now?: string;
  generateId?: () => string;
}): { memory: ProjectMemory; changed: boolean; architectureChanged: boolean } {
  const now = input.now ?? new Date().toISOString();
  const generateId = input.generateId ?? createUuid;
  const patch = input.patch;
  let changed = false;
  let requirements = [...input.memory.requirements];

  for (const feature of patch.features ?? []) {
    const index = findRequirement(requirements, feature);
    if (feature.action === "add") {
      if (!feature.description || requirements.some((item) => key(item.description) === key(feature.description!))) continue;
      requirements.push({
        ...createRequirement({ projectId: input.memory.projectId, description: feature.description, category: feature.category ?? "core_functionality", type: feature.type, priority: feature.priority, required: feature.required, source: "user", sourceMessageId: input.sourceMessageId, status: "confirmed", confidence: "high", now }),
        briefChangeStatus: "new",
      });
      changed = true;
      continue;
    }
    if (index < 0) continue;
    const current = requirements[index]!;
    if (feature.action === "remove") {
      if (current.status === "rejected") continue;
      requirements[index] = { ...current, status: "rejected", briefChangeStatus: "removed", sourceMessageId: input.sourceMessageId, version: current.version + 1, updatedAt: now };
      changed = true;
      continue;
    }
    const nextDescription = feature.description?.trim() || current.description;
    requirements[index] = {
      ...current,
      description: nextDescription,
      ...(feature.type ? { type: feature.type } : {}),
      ...(feature.category ? { category: feature.category } : {}),
      ...(feature.priority ? { priority: feature.priority } : {}),
      ...(typeof feature.required === "boolean" ? { required: feature.required } : {}),
      source: "user",
      status: "confirmed",
      confidence: "high",
      sourceMessageId: input.sourceMessageId,
      briefChangeStatus: "changed",
      version: current.version + 1,
      updatedAt: now,
    };
    changed = true;
  }

  let decisions = [...(input.memory.decisions ?? [])];
  if (patch.decisions) {
    const removed = new Set(patch.decisions.remove.map(key));
    if (removed.size) {
      decisions = decisions.map((item) => removed.has(key(item.decision)) ? { ...item, status: "rejected" as const, updatedAt: now } : item);
      changed = true;
    }
    for (const item of patch.decisions.add) {
      if (decisions.some((existing) => key(existing.decision) === key(item.decision) && existing.status !== "rejected")) continue;
      decisions.push({ id: generateId(), projectId: input.memory.projectId, decision: item.decision, reason: item.reason, source: "assistant_proposal", sourceMessageId: input.sourceMessageId, confidence: "medium", status: "proposed", createdAt: now, updatedAt: now });
      changed = true;
    }
  }

  let openQuestions = [...input.memory.openQuestions];
  if (patch.openQuestions) {
    const resolved = new Set(patch.openQuestions.resolve.map(key));
    openQuestions = openQuestions.map((item) => resolved.has(key(item.question)) ? { ...item, resolved: true } : item);
    for (const question of patch.openQuestions.add) {
      if (openQuestions.some((item) => key(item.question) === key(question))) continue;
      openQuestions.push({ id: generateId(), question, area: "core_functionality", importance: 3, informationGain: 3, dependencyImpact: 2, uncertainty: 3, asked: false, resolved: false, source: "answer" });
    }
    changed = changed || resolved.size > 0 || patch.openQuestions.add.length > 0;
  }

  const users = patch.targetUsers ? updateList(input.memory.users, patch.targetUsers.add, patch.targetUsers.remove) : input.memory.users;
  const stack = patch.techChoices ? updateList(input.memory.confirmedStack, patch.techChoices.add, patch.techChoices.remove) : input.memory.confirmedStack;
  const constraints = patch.constraints ? updateList(input.memory.constraints, patch.constraints.add, patch.constraints.remove) : input.memory.constraints;
  const architectureChanged = Boolean(patch.architecture?.changed && patch.architecture.summary && key(patch.architecture.summary) !== key(input.memory.architectureSummary ?? ""));
  changed = changed || Boolean(patch.goal && key(patch.goal) !== key(input.memory.purpose))
    || !sameList(users, input.memory.users) || !sameList(stack, input.memory.confirmedStack) || !sameList(constraints, input.memory.constraints)
    || architectureChanged;

  return {
    memory: {
      ...input.memory,
      purpose: patch.goal?.trim() || input.memory.purpose,
      users,
      confirmedStack: stack,
      constraints,
      requirements,
      decisions,
      openQuestions,
      ...(architectureChanged ? { architectureSummary: patch.architecture!.summary!.trim() } : {}),
      ...(changed ? { version: input.memory.version + 1, updatedAt: now } : {}),
    },
    changed,
    architectureChanged,
  };
}
