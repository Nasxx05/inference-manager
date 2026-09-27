import type { CompletenessResult, PlanningDepth, ProjectMemory } from "@/types/project";
import { detectRequirementGaps } from "./gaps";

const THRESHOLDS: Record<PlanningDepth, number> = {
  fast: 55,
  balanced: 70,
  thorough: 82,
};

export function calculateCompleteness(
  memory: Omit<ProjectMemory, "completeness">,
  depth: PlanningDepth,
): CompletenessResult {
  const gaps = detectRequirementGaps(memory as ProjectMemory);
  const criticalGaps = gaps.filter((gap) => gap.critical).map((gap) => gap.label);
  const optionalGaps = gaps.filter((gap) => !gap.critical).map((gap) => gap.label);
  const confirmed = memory.requirements.filter((item) => item.status === "confirmed").length;
  const active = memory.requirements.filter(
    (item) => item.status !== "rejected" && item.status !== "superseded",
  ).length;
  const conflictPenalty = memory.conflicts.filter((conflict) => !conflict.resolved).length * 12;
  const requirementScore = Math.min(35, confirmed * 7 + Math.max(0, active - confirmed) * 3);
  const areaScore = Math.min(40, Math.max(0, 40 - criticalGaps.length * 10 - optionalGaps.length * 3));
  const acceptanceScore = memory.acceptanceCriteria.length > 0 ? 15 : 0;
  const score = Math.max(0, Math.min(100, requirementScore + areaScore + acceptanceScore - conflictPenalty));
  const threshold = THRESHOLDS[depth];
  const level = score >= threshold && criticalGaps.length === 0
    ? "ready"
    : score >= Math.max(35, threshold - 20)
      ? "developing"
      : "insufficient";

  return {
    level,
    score,
    criticalGaps,
    optionalGaps,
    explanation:
      level === "ready"
        ? "There is enough structured information to produce a solid specification."
        : criticalGaps.length
          ? `${criticalGaps.length} important decision${criticalGaps.length === 1 ? " remains" : "s remain"} before the specification is ready.`
          : "The project is taking shape; a few more details will make the specification more reliable.",
  };
}
