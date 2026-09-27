import type { ProjectMemory, RequirementConflict } from "@/types/project";

const CONTRADICTION_PAIRS: Array<{ left: RegExp; right: RegExp; explanation: string }> = [
  {
    left: /no (accounts?|login|authentication|sign[- ]?up)/i,
    right: /(private|personal|per[- ]?user|each user|role[- ]?based)/i,
    explanation: "Private or per-user areas normally require a way to identify users.",
  },
  {
    left: /(no|without) (database|storage)/i,
    right: /(save|store|persist|history|orders?|bookings?)/i,
    explanation: "Saving information requires some form of persistent storage.",
  },
  {
    left: /(offline|no internet)/i,
    right: /(live|real[- ]?time|webhook|online payment)/i,
    explanation: "Live integrations generally require network connectivity.",
  },
];

export function detectContradictions(memory: ProjectMemory): RequirementConflict[] {
  const active = memory.requirements.filter(
    (item) => item.status !== "rejected" && item.status !== "superseded",
  );
  const conflicts: RequirementConflict[] = [];

  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const left = active[leftIndex]!;
      const right = active[rightIndex]!;
      const combined = `${left.description} ${right.description}`;
      const match = CONTRADICTION_PAIRS.find(
        (pair) => (pair.left.test(left.description) && pair.right.test(right.description)) ||
          (pair.left.test(right.description) && pair.right.test(left.description)),
      );
      if (!match) continue;
      const ids = [left.id, right.id].sort();
      conflicts.push({
        id: `conflict:${ids.join(":")}`,
        requirementIds: ids,
        description: `Potential contradiction between “${left.description}” and “${right.description}”.`,
        explanation: `${match.explanation} Please confirm which requirement should govern.`,
        resolved: false,
      });
      void combined;
    }
  }

  return conflicts;
}
