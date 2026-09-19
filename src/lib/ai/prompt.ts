/**
 * Prompt normalization and validation.
 *
 * Shared by the combined path and the two-call fallback so a prompt is
 * validated identically whichever route produced it. This is the guard that
 * keeps a performance optimization from quietly producing worse prompts: the
 * structure requirement is enforced, not merely requested.
 */

/** A real prompt always clears this; anything shorter is a fragment. */
export const MIN_PROMPT_CHARS = 400;

/**
 * Upper bound on a usable prompt. Generous on purpose: a long-but-valid prompt
 * should not be discarded, but a runaway response is not a prompt.
 */
export const MAX_PROMPT_CHARS = 40000;

/**
 * Section concepts that must be present.
 *
 * Checked case-insensitively and allowing internal whitespace differences:
 * "Outof Scope" and "OUT OF SCOPE" both pass. A minor formatting difference
 * must not reject a valid prompt, but every required concept must exist.
 */
export const REQUIRED_CONCEPTS = [
  "role",
  "objective",
  "context",
  "requirements",
  "scope",
  "outofscope",
  "priorities",
  "executionstrategy",
  "constraints",
  // Required in its own right, not merely as part of "constraints": the budget
  // is the point of Promgent, and a prompt that never states it is not an
  // Promgent prompt.
  "budgetconstraint",
  "validation",
  "revisionpolicy",
  "stoppingconditions",
  "outputformat",
] as const;

/** Collapses case and spacing so header formatting can vary. */
export function sectionKey(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Removes code fences the model may have wrapped the prompt in. */
export function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md|text|prompt)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** Trims anything before the ROLE header instead of discarding the response. */
export function trimToStart(prompt: string): string {
  const index = prompt.search(/^#{0,6}\s*ROLE\b/m);
  if (index <= 0) return prompt.trimStart();
  return prompt.slice(index).trimStart();
}

/** Keeps the model from returning an essay or a fragment. */
export function acceptablePrompt(prompt: string): boolean {
  if (!prompt || prompt.length < MIN_PROMPT_CHARS || prompt.length > MAX_PROMPT_CHARS) {
    return false;
  }
  const normalized = sectionKey(prompt);
  if (!REQUIRED_CONCEPTS.every((concept) => normalized.includes(concept))) return false;
  // Must start at the first section rather than with conversational preamble.
  const head = prompt.trimStart();
  return head.startsWith("ROLE") || /^#{0,6}\s*ROLE\b/.test(head);
}

/** Names the concepts a rejected prompt is missing, for a specific error. */
export function missingPromptConcepts(prompt: string): string[] {
  const normalized = sectionKey(prompt);
  return REQUIRED_CONCEPTS.filter((concept) => !normalized.includes(concept));
}