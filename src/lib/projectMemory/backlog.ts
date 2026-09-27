import type { ProjectMemory, QuestionBacklogItem } from "@/types/project";
import { detectRequirementGaps } from "./gaps";

function backlogId(area: string): string {
  return `question:${area}`;
}

export function refreshQuestionBacklog(memory: Pick<ProjectMemory, "openQuestions" | "requirements">): QuestionBacklogItem[] {
  const existing = new Map(memory.openQuestions.map((item) => [item.id, item]));
  const gaps = detectRequirementGaps(memory);
  const next: QuestionBacklogItem[] = [];

  for (const gap of gaps) {
    const id = backlogId(gap.area);
    const previous = existing.get(id);
    next.push({
      id,
      question: gap.question,
      area: gap.area,
      importance: gap.critical ? 1 : 0.65,
      informationGain: gap.critical ? 0.95 : 0.55,
      dependencyImpact: gap.area === "core_functionality" || gap.area === "users" ? 0.9 : 0.45,
      uncertainty: previous?.uncertainty ?? 0.8,
      asked: previous?.asked ?? false,
      resolved: false,
      source: previous?.source ?? "gap",
    });
  }

  return next.sort((a, b) => {
    const scoreA = a.importance + a.informationGain + a.dependencyImpact + a.uncertainty;
    const scoreB = b.importance + b.informationGain + b.dependencyImpact + b.uncertainty;
    return scoreB - scoreA;
  });
}

export function nextBestQuestion(memory: Pick<ProjectMemory, "openQuestions" | "requirements">): QuestionBacklogItem | undefined {
  return refreshQuestionBacklog(memory).find((item) => !item.resolved);
}
