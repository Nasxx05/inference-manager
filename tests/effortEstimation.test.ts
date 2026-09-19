/**
 * Workload-aware estimation: the tests that matter.
 *
 * The brief's central complaint was that a production RAG agent or a full SaaS
 * platform could come back as "7 CREDIT" or "10 CREDIT" because the estimate
 * came from a complexity label rather than from the actual work.
 *
 * These tests pin the ordering that must hold: a simple task stays cheap, and
 * increasingly large tasks get increasingly expensive — because the underlying
 * work differs, not because every number was scaled up.
 */

import { describe, expect, it } from "vitest";
import { findModelOrThrow } from "@/data/models";
import { allocatePhaseCosts, estimateCost } from "@/lib/estimator/costEstimator";
import { resolveTaskEffort, estimateRequirementCount } from "@/lib/estimator/taskEffort";
import { buildIterationModel } from "@/lib/estimator/iterationEstimator";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import type { OptimizationPreference, TaskAnalysis } from "@/types";

const OPUS = findModelOrThrow("claude-opus");
const MINI = findModelOrThrow("gpt-4o-mini");

const SIMPLE = "Write a product description.";
const MEDIUM = "Build a responsive portfolio website.";
const COMPLEX =
  "Build a RAG agent with document ingestion, embeddings, vector database, retrieval, evaluation and authentication.";
const VERY_COMPLEX =
  "Build a full production SaaS platform with authentication, database, backend APIs, payments, admin dashboard, analytics and deployment.";

function analysisFor(task: string): TaskAnalysis {
  return heuristicAnalyze(task);
}

function cost(task: string, preference: OptimizationPreference = "balanced", model = OPUS) {
  return estimateCost({
    analysis: analysisFor(task),
    model,
    preference,
    taskDescription: task,
  });
}

describe("task effort scales with real work", () => {
  it("counts distinct requirements rather than treating a system as one task", () => {
    const simple = estimateRequirementCount(SIMPLE);
    const complex = estimateRequirementCount(COMPLEX);
    const veryComplex = estimateRequirementCount(VERY_COMPLEX);

    expect(simple).toBeLessThan(complex);
    expect(complex).toBeLessThan(veryComplex);
    // A multi-feature system must be recognised as many requirements.
    expect(veryComplex).toBeGreaterThanOrEqual(4);
  });

  it("ranks effort in the same order as the underlying work", () => {
    const simple = resolveTaskEffort({ analysis: analysisFor(SIMPLE), taskDescription: SIMPLE });
    const medium = resolveTaskEffort({ analysis: analysisFor(MEDIUM), taskDescription: MEDIUM });
    const complex = resolveTaskEffort({ analysis: analysisFor(COMPLEX), taskDescription: COMPLEX });
    const very = resolveTaskEffort({
      analysis: analysisFor(VERY_COMPLEX),
      taskDescription: VERY_COMPLEX,
    });

    expect(simple.score).toBeLessThan(medium.score);
    expect(medium.score).toBeLessThan(complex.score);
    expect(complex.score).toBeLessThan(very.score);
  });

  it("assigns a heavier implementation load to a SaaS platform than a portfolio site", () => {
    const medium = resolveTaskEffort({ analysis: analysisFor(MEDIUM), taskDescription: MEDIUM });
    const very = resolveTaskEffort({
      analysis: analysisFor(VERY_COMPLEX),
      taskDescription: VERY_COMPLEX,
    });
    expect(very.implementationSize).toBeGreaterThan(medium.implementationSize);
  });

  it("models more iterations for complex work than simple work", () => {
    const simple = resolveTaskEffort({ analysis: analysisFor(SIMPLE), taskDescription: SIMPLE });
    const very = resolveTaskEffort({
      analysis: analysisFor(VERY_COMPLEX),
      taskDescription: VERY_COMPLEX,
    });

    expect(simple.estimatedIterations.max).toBeLessThanOrEqual(4);
    expect(very.estimatedIterations.max).toBeGreaterThan(simple.estimatedIterations.max);
    // The brief's band for very complex work is 6-12 iterations.
    expect(very.estimatedIterations.max).toBeGreaterThanOrEqual(6);
  });
});

/**
 * The regression this whole change exists to prevent.
 */
describe("complex tasks do not collapse into small estimates", () => {
  it("does not price a production RAG agent like a small task", () => {
    const estimate = cost(COMPLEX);
    // The brief's complaint was a result around 7 CREDIT for this task.
    expect(estimate.maximum).toBeGreaterThan(10);
    expect(estimate.minimumViable).toBeGreaterThan(5);
  });

  it("does not price a full SaaS platform like a small task", () => {
    const estimate = cost(VERY_COMPLEX);
    expect(estimate.maximum).toBeGreaterThan(15);
    expect(estimate.minimumViable).toBeGreaterThan(10);
  });

  it("keeps a simple task genuinely inexpensive", () => {
    const estimate = cost(SIMPLE);
    // Upgrading the engine must not inflate everything.
    expect(estimate.maximum).toBeLessThan(6);
  });

  it("increases cost monotonically with task size", () => {
    const simple = cost(SIMPLE).maximum;
    const medium = cost(MEDIUM).maximum;
    const complex = cost(COMPLEX).maximum;
    const very = cost(VERY_COMPLEX).maximum;

    expect(simple).toBeLessThan(medium);
    expect(medium).toBeLessThan(complex);
    expect(complex).toBeLessThan(very);
  });

  it("separates the three sizes by more than rounding noise", () => {
    const medium = cost(MEDIUM).maximum;
    const very = cost(VERY_COMPLEX).maximum;
    // The underlying work differs by an order of magnitude, so the estimate
    // should too — not by a token amount.
    expect(very / medium).toBeGreaterThan(2);
  });
});

describe("estimate shape", () => {
  it("always reports a range rather than a single figure", () => {
    for (const task of [SIMPLE, MEDIUM, COMPLEX, VERY_COMPLEX]) {
      const estimate = cost(task);
      expect(estimate.maximum).toBeGreaterThan(estimate.minimum);
    }
  });

  it("places minimum viable below the expected range and recommended maximum above it", () => {
    const estimate = cost(COMPLEX);
    expect(estimate.minimumViable).toBeLessThan(estimate.minimum);
    expect(estimate.recommendedMaximum).toBeGreaterThan(estimate.maximum);
  });

  it("reports a confidence level", () => {
    expect(["low", "medium", "high"]).toContain(cost(COMPLEX).confidence);
  });

  it("is less confident about a huge task than a small clear one", () => {
    // A huge multi-subsystem brief carries real unknowns; a short, specific
    // writing task does not.
    const huge = cost(VERY_COMPLEX);
    const clear = cost("Write a short product description for a running shoe.");
    expect(huge.confidence).not.toBe("high");
    expect(clear.confidence).toBe("high");
  });

  it("spreads the total across phases that sum to roughly the whole", () => {
    const estimate = cost(VERY_COMPLEX);
    const analysis = analysisFor(VERY_COMPLEX);
    const phases = allocatePhaseCosts(analysis, estimate);
    const total = phases.reduce(
      (sum: number, p: { estimatedCost: [number, number] }) => sum + p.estimatedCost[1],
      0,
    );
    // Allow slack for per-phase rounding.
    expect(Math.abs(total - estimate.maximum)).toBeLessThan(estimate.maximum * 0.35);
  });
});

describe("quality preference changes the estimate", () => {
  it("costs more at maximum quality than at minimize cost", () => {
    const cheap = cost(COMPLEX, "minimize-cost").maximum;
    const best = cost(COMPLEX, "maximum-quality").maximum;
    expect(best).toBeGreaterThan(cheap);
  });

  it("still keeps at least one correction pass when minimizing cost", () => {
    const effort = resolveTaskEffort({
      analysis: analysisFor(COMPLEX),
      taskDescription: COMPLEX,
    });
    const model = buildIterationModel(effort, "minimize-cost");
    // Testing and revision are never free.
    expect(model.revisionPasses).toBeGreaterThanOrEqual(1);
  });

  it("plans more validation passes at maximum quality", () => {
    const effort = resolveTaskEffort({
      analysis: analysisFor(COMPLEX),
      taskDescription: COMPLEX,
    });
    const balanced = buildIterationModel(effort, "balanced");
    const best = buildIterationModel(effort, "maximum-quality");
    expect(best.validationPasses).toBeGreaterThanOrEqual(balanced.validationPasses);
  });
});

describe("model pricing drives the cost", () => {
  it("costs more on a premium model than a budget model for the same work", () => {
    const opus = cost(COMPLEX, "balanced", OPUS).maximum;
    const mini = cost(COMPLEX, "balanced", MINI).maximum;
    expect(opus).toBeGreaterThan(mini);
  });

  it("records which model the estimate was produced for", () => {
    expect(cost(COMPLEX, "balanced", MINI).modelId).toBe(MINI.id);
  });
});