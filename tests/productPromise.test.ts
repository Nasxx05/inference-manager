/**
 * Tests for the actual product promise.
 *
 * Not unit tests of internals — these assert the behaviours a user or a judge
 * would check: that a bigger task costs more, that a weak model is flagged, that
 * budget changes the verdict, that answers move the estimate, that the original
 * wording survives the pipeline, and that a malformed model response cannot
 * crash the backend.
 */

import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { estimateCost } from "@/lib/estimator/costEstimator";
import { evaluateFeasibility } from "@/lib/estimator/feasibilityEngine";
import { evaluateSuitability } from "@/lib/models/suitability";
import { answerScopeSignal } from "@/lib/clarifier";
import { MODELS, findModelOrThrow } from "@/data/models";
import { validateAnalysis } from "@/lib/validation/schemas";
import type { TaskAnalysis } from "@/types";

const OPUS = findModelOrThrow("claude-opus");
const MINI = findModelOrThrow("gpt-4o-mini");

const PORTFOLIO = "Build a responsive portfolio website.";
const RAG =
  "Build a production RAG agent with document ingestion, chunking, embeddings, vector database, retrieval, reranking, generation, authentication, evaluation, logging, testing and deployment.";
const SAAS =
  "Build a complete multi-tenant SaaS application with authentication, database, backend APIs, payments, admin dashboard, analytics, email notifications and production deployment.";

function cost(task: string, model = OPUS) {
  return estimateCost({
    analysis: heuristicAnalyze(task),
    model,
    preference: "balanced",
    taskDescription: task,
  });
}

describe("the product promise", () => {
  it("gives a portfolio website a low-to-medium effort", () => {
    const estimate = cost(PORTFOLIO);
    const effort = estimate.effort!;
    expect(["low", "medium"]).toContain(effort.level);
    expect(effort.score).toBeLessThan(45);
  });

  it("gives a production RAG agent a high effort and a large estimate", () => {
    const estimate = cost(RAG);
    expect(["high", "very-high", "extreme"]).toContain(estimate.effort!.level);
    // The stated failure mode was a single-digit estimate for this task.
    expect(estimate.maximum).toBeGreaterThan(10);
  });

  it("gives a full SaaS application a very high effort and the largest estimate", () => {
    const estimate = cost(SAAS);
    expect(["very-high", "extreme"]).toContain(estimate.effort!.level);
    expect(estimate.maximum).toBeGreaterThan(15);
  });

  it("scales the estimate with the work, not by a blanket multiplier", () => {
    const portfolio = cost(PORTFOLIO).maximum;
    const rag = cost(RAG).maximum;
    const saas = cost(SAAS).maximum;

    expect(rag).toBeGreaterThan(portfolio);
    expect(saas).toBeGreaterThan(rag);
    // A simple task must stay inexpensive — the engine must not inflate
    // everything to make large tasks look large.
    expect(portfolio).toBeLessThan(10);
  });
});

describe("model suitability is independent of budget", () => {
  const ragAnalysis = heuristicAnalyze(RAG);

  it("flags a weak model for a complex RAG task", () => {
    const result = evaluateSuitability({
      model: MINI,
      analysis: ragAnalysis,
      taskDescription: RAG,
      candidates: MODELS,
      explicit: true,
    });
    expect(result.status).not.toBe("suitable");
    expect(result.capabilityGaps.length).toBeGreaterThan(0);
    // Never claims impossibility — only unreliability.
    expect(result.reasons.join(" ")).not.toMatch(/cannot do it/i);
    expect(result.suggestedModelId).toBeTruthy();
  });

  it("accepts a strong model for the same task", () => {
    const result = evaluateSuitability({
      model: OPUS,
      analysis: ragAnalysis,
      taskDescription: RAG,
      candidates: MODELS,
      explicit: true,
    });
    expect(result.status).toBe("suitable");
    expect(result.suggestedModelId).toBeUndefined();
  });
});

describe("budget changes the verdict", () => {
  const ragCost = cost(RAG);
  /**
   * A mid-size task whose estimate straddles 5-30 CREDIT, so those budgets
   * genuinely yield different verdicts. A production RAG build is priced far
   * above 30, so it would fail at every value and prove nothing.
   */
  const midCost = cost(PORTFOLIO);

  it("produces different verdicts across 5, 10, 20 and 30 CREDIT", () => {
    const verdicts = [5, 10, 20, 30].map((budget) =>
      evaluateFeasibility({
        userBudget: budget,
        estimatedMinimum: midCost.minimum,
        estimatedMaximum: midCost.maximum,
        minimumViable: midCost.minimumViable,
        recommendedMaximum: midCost.recommendedMaximum,
      }).status,
    );

    expect(new Set(verdicts).size).toBeGreaterThan(1);
    // The verdict must move monotonically toward feasible as budget grows.
    const order: Record<string, number> = {
      "does-not-fit": 0,
      tight: 1,
      "fits-with-optimization": 1,
      fits: 2,
    };
    expect(order[verdicts[3]]).toBeGreaterThanOrEqual(order[verdicts[0]]);
    expect(verdicts[3]).toBe("fits");
  });

  it("marks a generous budget as feasible", () => {
    const result = evaluateFeasibility({
      userBudget: 500,
      estimatedMinimum: ragCost.minimum,
      estimatedMaximum: ragCost.maximum,
      minimumViable: ragCost.minimumViable,
      recommendedMaximum: ragCost.recommendedMaximum,
    });
    expect(result.status).toBe("fits");
  });

  it("distinguishes a tight budget from an insufficient one", () => {
    // Tight: above the floor, below the recommended maximum.
    const tight = evaluateFeasibility({
      userBudget: ragCost.minimum + 0.01,
      estimatedMinimum: ragCost.minimum,
      estimatedMaximum: ragCost.maximum,
      minimumViable: ragCost.minimum * 0.5,
      recommendedMaximum: ragCost.recommendedMaximum,
    });
    expect(tight.status).toBe("tight");

    // Insufficient: below the minimum viable floor.
    const short = evaluateFeasibility({
      userBudget: 1,
      estimatedMinimum: ragCost.minimum,
      estimatedMaximum: ragCost.maximum,
      minimumViable: ragCost.minimumViable,
      recommendedMaximum: ragCost.recommendedMaximum,
    });
    expect(short.status).toBe("does-not-fit");
  });
});

describe("clarifying answers change the estimate", () => {
  const analysis = heuristicAnalyze("Build a RAG agent.");

  function costWithAnswers(answers: { question: string; answer: string }[]) {
    const signal = answerScopeSignal(
      answers.map((a, i) => ({
        id: `q${i}`,
        question: a.question,
        answer: a.answer,
        answered: true,
      })),
    );
    return estimateCost({
      analysis,
      model: OPUS,
      preference: "balanced",
      taskDescription: "Build a RAG agent.",
      answerMultiplier: signal.effortMultiplier,
      addedRequirements: signal.addedRequirements,
    });
  }

  it("costs more when authentication and multi-user are confirmed", () => {
    const minimal = costWithAnswers([
      { question: "Do you need authentication?", answer: "No authentication for now" },
      { question: "Will it support multiple users?", answer: "Single user only" },
    ]);
    const full = costWithAnswers([
      { question: "Do you need authentication?", answer: "Yes, email and password auth" },
      { question: "Will it support multiple users?", answer: "Yes, multi-user with teams" },
      { question: "Deployment?", answer: "Production deployment" },
    ]);

    expect(full.maximum).toBeGreaterThan(minimal.maximum);
    expect(full.effort!.requirementCount).toBeGreaterThan(minimal.effort!.requirementCount);
  });

  it("reports the confirmed components as cost drivers", () => {
    const signal = answerScopeSignal([
      {
        id: "q1",
        question: "Do you need authentication?",
        answer: "Yes, with payments and admin dashboard",
        answered: true,
      },
    ]);
    expect(signal.addedRequirements).toBeGreaterThan(0);
    expect(signal.effortMultiplier).toBeGreaterThan(1);
    expect(signal.reasons.join(" ")).toContain("component");
  });
});

describe("the original task survives the pipeline", () => {
  it("estimates from the original wording, not the summary", () => {
    const original =
      "Build a production RAG agent with ingestion, embeddings, vector database, retrieval, evaluation, authentication and deployment.";
    const analysis = heuristicAnalyze(original);

    // A deliberately lossy "summary" that a downstream component might use.
    const summaryOnly = "Build a RAG agent.";

    const fromOriginal = estimateCost({
      analysis,
      model: OPUS,
      preference: "balanced",
      taskDescription: original,
    });
    const fromSummary = estimateCost({
      analysis,
      model: OPUS,
      preference: "balanced",
      taskDescription: summaryOnly,
    });

    // The full request must genuinely cost more than the compressed version:
    // the detail is the work.
    expect(fromOriginal.maximum).toBeGreaterThan(fromSummary.maximum);
    expect(fromOriginal.effort!.requirementCount).toBeGreaterThan(
      fromSummary.effort!.requirementCount,
    );
  });
});

describe("malformed model responses do not crash", () => {
  const baseline = heuristicAnalyze(PORTFOLIO);

  it("accepts an empty object and falls back to the baseline", () => {
    const result = validateAnalysis({}, baseline);
    expect(result.summary).toBe(baseline.summary);
    expect(result.phases.length).toBeGreaterThan(0);
  });

  it("clamps absurd numeric values instead of propagating them", () => {
    const result = validateAnalysis(
      {
        taskType: "coding",
        summary: "A task.",
        complexity: "high",
        estimatedInputTokens: Number.MAX_SAFE_INTEGER,
        estimatedOutputTokens: -50,
        expectedIterations: 99999,
        phases: baseline.phases,
      },
      baseline,
    );
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(2_000_000);
    expect(result.estimatedOutputTokens).toBeGreaterThanOrEqual(100);
    expect(result.expectedIterations).toBeLessThanOrEqual(12);
  });

  it("ignores an unusable effort block rather than trusting it", () => {
    const result = validateAnalysis(
      { ...baseline, effort: { level: "not-a-level", score: "abc" } },
      baseline,
    );
    // A malformed effort must not produce a nonsense score.
    if (result.effort) {
      expect(Number.isFinite(result.effort.score)).toBe(true);
      expect(result.effort.score).toBeGreaterThanOrEqual(0);
      expect(result.effort.score).toBeLessThanOrEqual(100);
    }
  });

  it("never yields NaN from the estimator on hostile input", () => {
    const hostile: TaskAnalysis = {
      ...baseline,
      estimatedInputTokens: Number.NaN,
      estimatedOutputTokens: Number.NaN,
      phases: [],
    };
    const estimate = estimateCost({
      analysis: hostile,
      model: OPUS,
      preference: "balanced",
      taskDescription: PORTFOLIO,
    });
    expect(Number.isFinite(estimate.minimum)).toBe(true);
    expect(Number.isFinite(estimate.maximum)).toBe(true);
    expect(Number.isFinite(estimate.minimumViable)).toBe(true);
    expect(Number.isFinite(estimate.recommendedMaximum)).toBe(true);
    expect(estimate.maximum).toBeGreaterThan(0);
  });
});