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

/**
 * How the answers change the amount of work.
 *
 * Clarifying questions are only worth asking if they can change the plan. This
 * converts answers into an effort multiplier, so "authentication: yes" and
 * "multi-user: yes" measurably increase the estimate instead of merely
 * colouring the prompt.
 *
 * Only genuine increases are detected: an answer that removes work scales the
 * effort down. Everything is clamped, so a verbose free-text answer cannot
 * inflate an estimate without bound.
 */
export interface AnswerScopeSignal {
  /** Multiplier on effort. 1 = unchanged, >1 = more work, <1 = less. */
  effortMultiplier: number;
  /** Extra distinct requirements implied by the answers. */
  addedRequirements: number;
  /** Human-readable reasons, for the "why this estimate" panel. */
  reasons: string[];
}

/** Answers that clearly ADD a substantial unit of work. */
const ADDITIVE_PATTERNS: RegExp[] = [
  /\b(auth|authentication|login|sign[- ]?in|sign[- ]?up|user accounts?|oauth|jwt|session)\b/i,
  /\b(multi[- ]?user|multi[- ]?tenant|teams?|organi[sz]ations?|multiple users)\b/i,
  /\b(payment|payments|billing|checkout|subscription|stripe)\b/i,
  /\b(admin|admin dashboard|admin panel)\b/i,
  /\b(analytic|analytics|telemetry|metrics|reporting)\b/i,
  /\b(deploy|deployment|production[- ]?ready|production|infrastructure|ci\/cd|docker|kubernetes)\b/i,
  /\b(database|postgres|mysql|mongo|sqlite|orm|schema|migration)\b/i,
  /\b(api|rest|graphql|endpoints?|backend service)\b/i,
  /\b(vector (db|database|store)|pinecone|weaviate|qdrant|chroma|pgvector|hosted vector)\b/i,
  /\b(embedding|embeddings|rerank|reranking|hybrid search)\b/i,
  /\b(evaluation|eval|benchmark|labelled dataset|quality metrics)\b/i,
  /\b(real[- ]time|streaming|websocket|live updates)\b/i,
  /\b(email|notification|notifications|sms|webhook)\b/i,
  /\b(mobile|ios|android|react native|flutter)\b/i,
  /\b(test|tests|testing|unit tests|e2e|integration tests)\b/i,
  /\b(internationali[sz]ation|i18n|locali[sz]ation|multi[- ]?language)\b/i,
  /\b(accessibility|a11y|wcag)\b/i,
  /\b(search|full[- ]?text search|filtering|pagination)\b/i,
  /\b(file upload|upload|storage|s3|blob)\b/i,
  /\b(rate[- ]?limit|rate limiting|caching|cache|redis)\b/i,
];

/** Answers that clearly REDUCE or defer work. */
const REDUCTIVE_PATTERNS: RegExp[] = [
  /\b(no auth|without auth|no authentication|no login|no accounts?)\b/i,
  /\b(no\b[^.]{0,20}\bpayment|no payment|without payment|no billing)\b/i,
  /\b(simulated|mock|mock data|fake|dummy|placeholder)\b/i,
  /\b(prototype|prototype only|minimal|minimal version|basic|simple)\b/i,
  /\b(no (deployment|deploy)|without deployment|local only|skip deployment)\b/i,
  /\b(single[- ]?user|one user|just me|personal use)\b/i,
  /\b(no (test|tests|testing)|without tests|skip tests?)\b/i,
  /\b(no (evaluation|eval)|without evaluation|skip evaluation)\b/i,
  /\b(no database|without database|in[- ]memory|no persistence)\b/i,
];

/**
 * Derives a scope signal from the answers.
 *
 * Skipped answers (which resolve to their defaults) are included: a default
 * such as "email and password authentication" still describes real work, and
 * ignoring it would understate the task.
 */
export function answerScopeSignal(answers: ClarifyingAnswer[]): AnswerScopeSignal {
  const reasons: string[] = [];
  let additions = 0;
  let reductions = 0;

  for (const answer of answers) {
    const text = `${answer.question} ${answer.answer}`;

    for (const pattern of ADDITIVE_PATTERNS) {
      if (pattern.test(text)) {
        additions += 1;
        break; // Count each answer once; one answer is one unit of work.
      }
    }

    if (REDUCTIVE_PATTERNS.some((pattern) => pattern.test(text))) {
      reductions += 1;
    }
  }

  // Each confirmed component adds a modest amount; each simplification removes
  // a little. Diminishing returns on the additive side, so a long answer list
  // grows the estimate without running away.
  const additiveGain = Math.min(additions, 12) * 0.055;
  const reductiveGain = Math.min(reductions, 6) * 0.05;
  const multiplier = clamp(1 + additiveGain - reductiveGain, 0.75, 1.75);

  if (additions > 0) {
    reasons.push(`${additions} confirmed component${additions === 1 ? "" : "s"} added to scope`);
  }
  if (reductions > 0) {
    reasons.push(`${reductions} area${reductions === 1 ? "" : "s"} simplified or deferred`);
  }

  return {
    effortMultiplier: Math.round(multiplier * 1000) / 1000,
    // Confirmed components are real requirements, not prose.
    addedRequirements: Math.min(additions, 12),
    reasons,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
