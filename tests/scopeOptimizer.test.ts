import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { estimateCost } from "@/lib/estimator/costEstimator";
import { findModelOrThrow } from "@/data/models";
import { applyScopeReduction, optimizeScope } from "@/lib/scopeOptimizer/scopeOptimizer";

const BIG_TASK =
  "Build a complete ecommerce platform with authentication, real payment processing, admin dashboard, order management and analytics.";

const bigTask = heuristicAnalyze(BIG_TASK);

describe("scope optimizer", () => {
  it("produces included, deferred and simplified lists for a large task with a small budget", () => {
    const scope = optimizeScope(bigTask, 5);
    expect(scope.included.length).toBeGreaterThan(0);
    expect(scope.deferred.length).toBeGreaterThan(0);
    expect(scope.simplified.length).toBeGreaterThan(0);
    expect(scope.rationale).toContain("5");
  });

  it("defers known expensive features for an ecommerce task", () => {
    const scope = optimizeScope(bigTask, 5);
    const joined = scope.deferred.join(" | ").toLowerCase();
    expect(joined).toContain("payment");
    expect(joined).toContain("admin");
  });

  it("reduces the estimated cost when the optimized scope is applied", () => {
    const model = findModelOrThrow("claude-sonnet");
    const before = estimateCost({
      analysis: bigTask,
      model,
      preference: "balanced",
      taskDescription: BIG_TASK,
    });
    const scope = optimizeScope(bigTask, 5);
    const after = estimateCost({
      analysis: applyScopeReduction(bigTask, scope, BIG_TASK),
      model,
      preference: "balanced",
      taskDescription: BIG_TASK,
    });

    expect(after.maximum).toBeLessThan(before.maximum);
    // The reduction must be real, not rounding.
    expect(after.maximum).toBeLessThan(before.maximum * 0.95);
  });

  /**
   * The optimizer must work toward the budget, not just cut a fixed fraction.
   *
   * Repeated passes each re-estimate and defer more only while it helps, so a
   * scope is returned only when it has actually been verified to fit.
   */
  it("iteratively converges toward the target budget when reduction can help", () => {
    const model = findModelOrThrow("claude-sonnet");
    const budget = 200;

    let scope = optimizeScope(bigTask, budget);
    let estimate = estimateCost({
      analysis: applyScopeReduction(bigTask, scope, BIG_TASK),
      model,
      preference: "balanced",
      taskDescription: BIG_TASK,
    });
    const start = estimate.maximum;

    for (let pass = 0; pass < 4 && estimate.recommendedMaximum > budget; pass += 1) {
      const next = optimizeScope(
        applyScopeReduction(bigTask, scope, BIG_TASK),
        budget,
      );
      if (next.deferred.length <= scope.deferred.length) break;
      scope = {
        ...next,
        deferred: [...next.deferred, ...scope.deferred.filter((d) => !next.deferred.includes(d))],
      };
      estimate = estimateCost({
        analysis: applyScopeReduction(bigTask, scope, BIG_TASK),
        model,
        preference: "balanced",
        taskDescription: BIG_TASK,
      });
    }

    // Either it now fits, or it genuinely cannot be reduced further.
    const exhausted = scope.deferred.length >= bigTask.phases.length;
    expect(estimate.recommendedMaximum <= budget || exhausted).toBe(true);
    // Never INCREASE the estimate while trying to reduce it.
    expect(estimate.maximum).toBeLessThanOrEqual(start);
  });

  it("keeps essential phases in the included scope", () => {
    const scope = optimizeScope(bigTask, 5);
    const essential = bigTask.phases.filter((p) => p.priority === "essential");
    for (const phase of essential) {
      expect(scope.included.join(" | ")).toContain(phase.name);
    }
  });

  it("does not produce duplicate scope items", () => {
    const scope = optimizeScope(bigTask, 5);
    const counts = new Map<string, number>();
    for (const item of [...scope.included, ...scope.deferred, ...scope.simplified]) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      expect(count).toBe(1);
    }
  });

  it("handles a task with a single phase", () => {
    const small = heuristicAnalyze("Write a short email.");
    const scope = optimizeScope({ ...small, phases: small.phases.slice(0, 1) }, 1);
    expect(scope.included.length).toBeGreaterThan(0);
  });
});