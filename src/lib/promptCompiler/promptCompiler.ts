import type { PlanResult } from "@/types";

/**
 * The prompt is written by Promgent's internal model
 * (`src/lib/ai/promptGenerator.ts`), which follows the section structure
 * defined there. This module no longer compiles prompts locally; it keeps only
 * the helpers the rest of the app depends on.
 */

/** Short, readable label for a plan, used in history and headings. */
export function planToHistoryName(plan: PlanResult): string {
  const summary = plan.analysis.summary?.trim();
  if (summary) return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
  const first = plan.taskDescription.trim().split("\n")[0];
  return first.length > 60 ? `${first.slice(0, 57)}...` : first || "Untitled task";
}