import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { allocatePhaseCosts, estimateCost, formatRange } from "@/lib/estimator/costEstimator";
import { findModelOrThrow } from "@/data/models";
import type { TaskAnalysis } from "@/types";

const analysis: TaskAnalysis = {
  ...heuristicAnalyze(
    "Build a responsive SaaS landing page using Next.js and TypeScript with pricing, testimonials and a contact form.",
  ),
  estimatedInputTokens: 12000,
  estimatedOutputTokens: 9000,
  expectedIterations: 3,
};

describe("cost estimation", () => {
  it("computes cost from structured pricing, not from invented numbers", () => {
    const model = findModelOrThrow("claude-sonnet");
    const estimate = estimateCost(analysis, model, "balanced");

    const expectedInput = (12000 / 1_000_000) * model.inputPrice;
    const expectedOutput = (9000 / 1_000_000) * model.outputPrice;

    expect(estimate.inputCost).toBeCloseTo(expectedInput, 3);
    expect(estimate.outputCost).toBeCloseTo(expectedOutput, 3);
    expect(estimate.baseExecutionCost).toBeCloseTo(expectedInput + expectedOutput, 3);
  });

  it("accounts for iterations and overhead", () => {
    const model = findModelOrThrow("claude-sonnet");
    const single = estimateCost({ ...analysis, expectedIterations: 1 }, model, "balanced");
    const multi = estimateCost({ ...analysis, expectedIterations: 4 }, model, "balanced");

    expect(multi.iterationCost).toBeGreaterThan(0);
    expect(multi.maximum).toBeGreaterThan(single.maximum);
  });

  it("produces a range and a higher recommended maximum", () => {
    const model = findModelOrThrow("claude-sonnet");
    const estimate = estimateCost(analysis, model, "balanced");

    expect(estimate.maximum).toBeGreaterThan(estimate.minimum);
    expect(estimate.recommendedMaximum).toBeGreaterThanOrEqual(estimate.maximum);
  });

  it("handles a low budget and decimal budgets without producing zero or NaN", () => {
    const model = findModelOrThrow("gpt-4o-mini");
    const estimate = estimateCost(analysis, model, "minimize-cost");

    expect(Number.isFinite(estimate.minimum)).toBe(true);
    expect(estimate.minimum).toBeGreaterThan(0);
    expect(Number.isFinite(estimate.recommendedMaximum)).toBe(true);
  });

  it("scales cost with model price", () => {
    const cheap = estimateCost(analysis, findModelOrThrow("gpt-4o-mini"), "balanced");
    const expensive = estimateCost(analysis, findModelOrThrow("claude-opus"), "balanced");
    expect(expensive.maximum).toBeGreaterThan(cheap.maximum);
  });

  it("prefers cheaper strategies under minimize-cost", () => {
    const model = findModelOrThrow("claude-sonnet");
    const cheap = estimateCost(analysis, model, "minimize-cost");
    const quality = estimateCost(analysis, model, "maximum-quality");
    expect(cheap.recommendedMaximum).toBeLessThan(quality.recommendedMaximum);
  });

  it("allocates phase costs that sum to the total range", () => {
    const model = findModelOrThrow("claude-sonnet");
    const estimate = estimateCost(analysis, model, "balanced");
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