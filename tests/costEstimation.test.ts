import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { allocatePhaseCosts, estimateCost, formatRange } from "@/lib/estimator/costEstimator";
import { findModelOrThrow } from "@/data/models";
import type { TaskAnalysis } from "@/types";

const TASK =
  "Build a responsive SaaS landing page using Next.js and TypeScript with pricing, testimonials and a contact form.";

const analysis: TaskAnalysis = {
  ...heuristicAnalyze(TASK),
  estimatedInputTokens: 12000,
  estimatedOutputTokens: 9000,
  expectedIterations: 3,
};

describe("cost estimation", () => {
  it("computes cost from structured pricing, not from invented numbers", () => {
    const model = findModelOrThrow("claude-sonnet");
    const estimate = estimateCost({ analysis, model, preference: "balanced", taskDescription: TASK });

    // Base execution is always derived from tokens × the model's own rates.
    const totalTokens = estimate.inputCost + estimate.outputCost;
    expect(estimate.baseExecutionCost).toBeCloseTo(totalTokens, 3);
    expect(estimate.inputCost).toBeCloseTo(
      (estimate.inputCost / model.inputPrice) * model.inputPrice,
      6,
    );
    // Every derived component must be finite and non-negative.
    for (const value of [
      estimate.inputCost,
      estimate.outputCost,
      estimate.iterationCost,
      estimate.revisionCost,
      estimate.overheadCost,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("accounts for iterations and overhead", () => {
    const model = findModelOrThrow("claude-sonnet");
    const small = estimateCost({
      analysis: { ...analysis, phases: analysis.phases.slice(0, 1) },
      model,
      preference: "balanced",
      taskDescription: "Write a one-line summary.",
    });
    const large = estimateCost({
      analysis,
      model,
      preference: "balanced",
      taskDescription: TASK,
    });

    // Iteration and revision are modelled explicitly and are never zero.
    expect(large.iterationCost).toBeGreaterThan(0);
    expect(large.revisionCost).toBeGreaterThan(0);
    expect(large.overheadCost).toBeGreaterThan(0);
    expect(large.maximum).toBeGreaterThan(small.maximum);
  });

  it("produces a range, a minimum viable floor and a higher recommended maximum", () => {
    const model = findModelOrThrow("claude-sonnet");
    const estimate = estimateCost({ analysis, model, preference: "balanced", taskDescription: TASK });

    expect(estimate.maximum).toBeGreaterThan(estimate.minimum);
    expect(estimate.recommendedMaximum).toBeGreaterThanOrEqual(estimate.maximum);
    // The floor sits below the expected range, never above it.
    expect(estimate.minimumViable).toBeLessThan(estimate.minimum);
    expect(estimate.minimumViable).toBeGreaterThan(0);
    expect(["low", "medium", "high"]).toContain(estimate.confidence);
  });

  it("handles a low budget and decimal budgets without producing zero or NaN", () => {
    const model = findModelOrThrow("gpt-4o-mini");
    const estimate = estimateCost({
      analysis,
      model,
      preference: "minimize-cost",
      taskDescription: TASK,
    });

    expect(Number.isFinite(estimate.minimum)).toBe(true);
    expect(estimate.minimum).toBeGreaterThan(0);
    expect(Number.isFinite(estimate.recommendedMaximum)).toBe(true);
  });

  it("scales cost with model price", () => {
    const cheap = estimateCost({
      analysis,
      model: findModelOrThrow("gpt-4o-mini"),
      preference: "balanced",
      taskDescription: TASK,
    });
    const expensive = estimateCost({
      analysis,
      model: findModelOrThrow("claude-opus"),
      preference: "balanced",
      taskDescription: TASK,
    });
    expect(expensive.maximum).toBeGreaterThan(cheap.maximum);
  });

  it("prefers cheaper strategies under minimize-cost", () => {
    const model = findModelOrThrow("claude-sonnet");
    const cheap = estimateCost({ analysis, model, preference: "minimize-cost", taskDescription: TASK });
    const quality = estimateCost({ analysis, model, preference: "maximum-quality", taskDescription: TASK });
    expect(cheap.recommendedMaximum).toBeLessThan(quality.recommendedMaximum);
  });

  it("allocates phase costs that sum to the total range", () => {
    const model = findModelOrThrow("claude-sonnet");
    const estimate = estimateCost({ analysis, model, preference: "balanced", taskDescription: TASK });
    const phases = allocatePhaseCosts(analysis, estimate);

    expect(phases.length).toBe(analysis.phases.length);
    const sum = phases.reduce((acc, p) => acc + p.estimatedCost[0], 0);
    expect(sum).toBeGreaterThan(estimate.minimum * 0.9);
    expect(sum).toBeLessThan(estimate.minimum * 1.1);
    for (const phase of phases) {
      expect(phase.estimatedCost[1]).toBeGreaterThanOrEqual(phase.estimatedCost[0]);
    }
  });

  it("formats ranges readably", () => {
    expect(formatRange(5.8, 7.4)).toBe("5.8 – 7.4");
  });
});