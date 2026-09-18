import { describe, expect, it } from "vitest";
import { evaluateFeasibility, planReserve } from "@/lib/estimator/feasibilityEngine";

describe("budget feasibility", () => {
  it("reports fits when the recommended maximum is within budget", () => {
    const result = evaluateFeasibility({
      userBudget: 10,
      estimatedMinimum: 6.2,
      estimatedMaximum: 7.4,
      recommendedMaximum: 8,
    });
    expect(result.status).toBe("fits");
    expect(result.headline).toBe("Fits your budget");
  });

  it("reports fits-with-optimization when the upper end exceeds budget", () => {
    const result = evaluateFeasibility({
      userBudget: 10,
      estimatedMinimum: 9,
      estimatedMaximum: 12,
      recommendedMaximum: 13,
    });
    expect(result.status).toBe("fits-with-optimization");
  });

  it("reports does-not-fit when even the minimum exceeds budget", () => {
    const result = evaluateFeasibility({
      userBudget: 5,
      estimatedMinimum: 14,
      estimatedMaximum: 19,
      recommendedMaximum: 21,
    });
    expect(result.status).toBe("does-not-fit");
    expect(result.headline).toBe("Does not fit your current budget");
  });

  it("reports fits-with-optimization when an optimized estimate fits", () => {
    const result = evaluateFeasibility({
      userBudget: 10,
      estimatedMinimum: 12,
      estimatedMaximum: 15,
      recommendedMaximum: 16,
      optimized: { minimum: 8.4, maximum: 9.7, recommendedMaximum: 10 },
    });
    expect(result.status).toBe("fits-with-optimization");
    expect(result.headline).toBe("Fits with reduced scope");
  });

  it("reports does-not-fit when the optimized estimate still exceeds budget", () => {
    const result = evaluateFeasibility({
      userBudget: 2,
      estimatedMinimum: 15,
      estimatedMaximum: 20,
      recommendedMaximum: 22,
      optimized: { minimum: 9, maximum: 12, recommendedMaximum: 13 },
    });
    expect(result.status).toBe("does-not-fit");
  });

  it("supports decimal budgets", () => {
    const result = evaluateFeasibility({
      userBudget: 7.5,
      estimatedMinimum: 5.8,
      estimatedMaximum: 6.7,
      recommendedMaximum: 7,
    });
    expect(result.status).toBe("fits");
  });

  it("builds a reserve plan that never exceeds the budget", () => {
    const plan = planReserve(10, 6.8, "fits");
    expect(plan.totalBudget).toBe(10);
    expect(plan.initialExecution + plan.recommendedReserve + plan.unusedMargin).toBeCloseTo(10, 2);
    expect(plan.recommendedReserve).toBeGreaterThan(0);
    expect(plan.explanation.length).toBeGreaterThan(0);
  });

  it("keeps reserve non-negative when the estimate exceeds the budget", () => {
    const plan = planReserve(5, 14, "does-not-fit");
    expect(plan.recommendedReserve).toBeGreaterThanOrEqual(0);
    expect(plan.unusedMargin).toBeGreaterThanOrEqual(0);
  });
});