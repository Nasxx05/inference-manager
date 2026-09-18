import type { ClarifyingAnswer, ClarifyingQuestion, TaskType } from "@/types";
import { CORE_BY_TYPE } from "./questionBank";
import { TRIGGERED_SETS } from "./triggeredSets";

export { CORE_BY_TYPE } from "./questionBank";
export { TRIGGERED_SETS } from "./triggeredSets";

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 6;

/**
 * Picks the questions that would actually change the outcome for this task.
 * Core questions come from the detected task type; any triggered set whose
 * pattern matches the description is appended afterwards.
 */
export function selectQuestions(
  taskDescription: string,
  taskType: TaskType,
): ClarifyingQuestion[] {
  const collected: ClarifyingQuestion[] = [];
  const seen = new Set<string>();

  const push = (question: ClarifyingQuestion) => {
    if (seen.has(question.id)) return;
    seen.add(question.id);
    collected.push(question);
  };

  const triggered = TRIGGERED_SETS.filter((set) => set.match.test(taskDescription));

  // A recognised sub-kind is more informative than the generic type, so it
  // gets to contribute first while the cap is still unreached.
  for (const set of triggered) {
    for (const question of set.questions) {
      if (collected.length >= MAX_QUESTIONS) break;
      push(question);
    }
  }

  for (const question of CORE_BY_TYPE[taskType] ?? CORE_BY_TYPE.general) {
    if (collected.length >= MAX_QUESTIONS) break;
    push(question);
  }

  if (collected.length < MIN_QUESTIONS) {
    for (const question of CORE_BY_TYPE.general) {
      if (collected.length >= MIN_QUESTIONS) break;
      push(question);
    }
  }

  return collected.slice(0, MAX_QUESTIONS);
}

/**
 * Merges submitted answers with the question definitions. Blank or missing
 * answers fall back to the question's default and are marked unanswered, so a
 * skipped question never blocks the run and never injects an empty line.
 */
export function resolveAnswers(
  questions: ClarifyingQuestion[],
  submitted: Record<string, string> | undefined,
): ClarifyingAnswer[] {
  const answers: ClarifyingAnswer[] = [];

  for (const question of questions) {
    const raw = submitted?.[question.id];
    const trimmed = typeof raw === "string" ? raw.trim() : "";

    if (trimmed.length > 0) {
      answers.push({
        id: question.id,
        question: question.question,
        answer: trimmed,
        answered: true,
      });
    } else {
      answers.push({
        id: question.id,
        question: question.question,
        answer: question.defaultValue,
        answered: false,
      });
    }
  }

  return answers;
}

/** True when at least one question was answered rather than skipped. */
export function answersUsed(answers: ClarifyingAnswer[]): boolean {
  return answers.some((answer) => answer.answered);
}