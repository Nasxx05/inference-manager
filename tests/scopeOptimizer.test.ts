import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { estimateCost } from "@/lib/estimator/costEstimator";
import { findModelOrThrow } from "@/data/models";
import { applyScopeReduction, optimizeScope } from "@/lib/scopeOptimizer/scopeOptimizer";

const bigTask = heuristicAnalyze(
  "Build a complete ecommerce platform with authentication, real payment processing, admin dashboard, order management and analytics.",
);

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
    const before = estimateCost(bigTask, model, "balanced");
    const scope = optimizeScope(bigTask, 5);
    const after = estimateCost(applyScopeReduction(bigTask, scope), model, "balanced");

    expect(after.maximum).toBeLessThan(before.maximum);
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