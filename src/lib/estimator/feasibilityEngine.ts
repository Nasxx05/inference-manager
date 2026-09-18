import type { FeasibilityResult, FeasibilityStatus, ReservePlan } from "@/types";
import { formatCredit, formatRange } from "./costEstimator";

export interface FeasibilityInput {
  userBudget: number;
  estimatedMinimum: number;
  estimatedMaximum: number;
  recommendedMaximum: number;
  optimized?: { minimum: number; maximum: number; recommendedMaximum: number } | null;
}

export function evaluateFeasibility(input: FeasibilityInput): FeasibilityResult {
  const { userBudget, estimatedMinimum, estimatedMaximum, recommendedMaximum, optimized } = input;

  if (optimized) {
    if (optimized.recommendedMaximum <= userBudget) {
      return {
        status: "fits-with-optimization",
        headline: "Fits with reduced scope",
        detail:
          `Original estimate ${formatRange(estimatedMinimum, estimatedMaximum)} CREDIT exceeds a ` +
          `${formatCredit(userBudget)} CREDIT budget. Optimized estimate ` +
          `${formatRange(optimized.minimum, optimized.maximum)} CREDIT fits.`,
      };
    }
    return {
      status: "does-not-fit",
      headline: "Does not fit your current budget",
      detail:
        `Even with reduced scope the estimated cost is ` +
        `${formatRange(optimized.minimum, optimized.maximum)} CREDIT, above your ` +
        `${formatCredit(userBudget)} CREDIT budget.`,
    };
  }

  if (recommendedMaximum <= userBudget) {
    return {
      status: "fits",
      headline: "Fits your budget",
      detail:
        `Estimated ${formatRange(estimatedMinimum, estimatedMaximum)} CREDIT against a ` +
        `${formatCredit(userBudget)} CREDIT budget, including a safety margin up to ` +
        `${formatCredit(recommendedMaximum)} CREDIT.`,
    };
  }

  if (estimatedMinimum <= userBudget) {
    return {
      status: "fits-with-optimization",
      headline: "Fits with optimization",
      detail:
        `Estimated ${formatRange(estimatedMinimum, estimatedMaximum)} CREDIT. The upper end ` +
        `exceeds your ${formatCredit(userBudget)} CREDIT budget, so scope reduction or a ` +
        `cheaper strategy is recommended.`,
    };
  }

  return {
    status: "does-not-fit",
    headline: "Does not fit your current budget",
    detail:
      `Estimated ${formatRange(estimatedMinimum, estimatedMaximum)} CREDIT against a ` +
      `${formatCredit(userBudget)} CREDIT budget. The minimum expected cost already exceeds ` +
      `the available budget.`,
  };
}

export function statusTone(status: FeasibilityStatus): "positive" | "warning" | "negative" {
  if (status === "fits") return "positive";
  if (status === "fits-with-optimization") return "warning";
  return "negative";
}

const RESERVE_SHARE: Record<FeasibilityStatus, number> = {
  fits: 0.2,
  "fits-with-optimization": 0.12,
  "does-not-fit": 0.1,
};

export function planReserve(
  userBudget: number,
  estimatedMaximum: number,
  status: FeasibilityStatus,
): ReservePlan {
  const initialExecution = Math.min(Math.max(0, estimatedMaximum), Math.max(0, userBudget));
  const rawReserve = Math.max(0, userBudget) * RESERVE_SHARE[status];
  const available = Math.max(0, userBudget - initialExecution);
  const recommendedReserve = available > 0 ? Math.min(rawReserve, available) : 0;
  const unusedMargin = Math.max(0, userBudget - initialExecution - recommendedReserve);

  return {
    totalBudget: round2(userBudget),
    initialExecution: round2(initialExecution),
    recommendedReserve: round2(recommendedReserve),
    unusedMargin: round2(unusedMargin),
    explanation:
      "We recommend keeping part of the budget available for revisions, debugging, or unexpected complexity.",
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}