import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import {
  AnalysisValidationError,
  parseBudget,
  parseOptimization,
  validateAnalysis,
} from "@/lib/validation/schemas";

const baseline = heuristicAnalyze("Build a landing page with React.");

describe("validation", () => {
  it("rejects a non-object payload", () => {
    expect(() => validateAnalysis(null, baseline)).toThrow(AnalysisValidationError);
  });

  it("falls back to the baseline for missing fields", () => {
    const result = validateAnalysis({ summary: "Do the thing" }, baseline);
    expect(result.taskType).toBe(baseline.taskType);
    expect(result.complexity).toBe(baseline.complexity);
    expect(result.phases).toEqual(baseline.phases);
  });

  it("rejects a payload with no summary when the baseline has none either", () => {
    const emptyBaseline = { ...baseline, summary: "" };
    expect(() => validateAnalysis({ taskType: "coding" }, emptyBaseline)).toThrow(
      AnalysisValidationError,
    );
  });

  it("normalizes an invalid task type to the baseline", () => {
    const result = validateAnalysis({ ...baseline, taskType: "not-a-type" }, baseline);
    expect(result.taskType).toBe(baseline.taskType);
  });

  it("clamps absurd token estimates", () => {
    const result = validateAnalysis(
      { ...baseline, estimatedInputTokens: 10_000_000, estimatedOutputTokens: -5 },
      baseline,
    );
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(2_000_000);
    expect(result.estimatedOutputTokens).toBeGreaterThanOrEqual(100);
  });

  it("clamps iteration counts", () => {
    const result = validateAnalysis({ ...baseline, expectedIterations: 500 }, baseline);
    expect(result.expectedIterations).toBeLessThanOrEqual(12);
    expect(result.expectedIterations).toBeGreaterThanOrEqual(1);
  });

  it("normalizes malformed phases but keeps valid ones", () => {
    const result = validateAnalysis(
      {
        ...baseline,
        phases: [
          { name: "Build", description: "Write the code", priority: "essential", costWeight: 1 },
          { name: "", description: "ignored" },
          "not-an-object",
        ],
      },
      baseline,
    );
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].name).toBe("Build");
  });

  it("falls back to baseline phases when all are invalid", () => {
    const result = validateAnalysis({ ...baseline, phases: [{ foo: 1 }] }, baseline);
    expect(result.phases).toEqual(baseline.phases);
  });

  it("parses budgets and rejects invalid ones", () => {
    expect(parseBudget(10)).toBe(10);
    expect(parseBudget("7.5")).toBe(7.5);
    expect(parseBudget("0")).toBeNull();
    expect(parseBudget(-3)).toBeNull();
    expect(parseBudget("abc")).toBeNull();
    expect(parseBudget("")).toBeNull();
  });

  it("rounds budgets to two decimals", () => {
    expect(parseBudget("10.005")).toBe(10.01);
  });

  it("parses optimization preferences", () => {
    expect(parseOptimization("balanced")).toBe("balanced");
    expect(parseOptimization("minimize-cost")).toBe("minimize-cost");
    expect(parseOptimization("maximum-quality")).toBe("maximum-quality");
    expect(parseOptimization("cheap")).toBeNull();
  });
});