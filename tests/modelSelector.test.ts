import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { MODELS, getModel } from "@/data/models";
import { buildComparison, selectModel } from "@/lib/models/modelSelector";

const EASY_TASK = "Write a short thank-you email to a client.";
const HARD_TASK =
  "Build a complete production-ready ecommerce platform with authentication, payments, admin dashboard, real-time inventory and analytics.";

const easy = heuristicAnalyze(EASY_TASK);
const hard = heuristicAnalyze(HARD_TASK);

describe("model selector", () => {
  it("selects a known model with reasons", () => {
    const rec = selectModel(easy, 10, "balanced", EASY_TASK);
    expect(getModel(rec.modelId)).toBeDefined();
    expect(rec.reasons.length).toBeGreaterThan(0);
    expect(rec.estimated).toBeGreaterThan(0);
  });

  it("does not always pick the cheapest model", () => {
    const rec = selectModel(hard, 50, "balanced", HARD_TASK);
    const cheapest = [...MODELS].sort(
      (a, b) => a.inputPrice + a.outputPrice - (b.inputPrice + b.outputPrice),
    )[0];
    expect(rec.modelId).not.toBe(cheapest.id);
  });

  it("never recommends a model over budget as the estimate grows", () => {
    for (const budget of [2, 5, 10, 50]) {
      const rec = selectModel(easy, budget, "minimize-cost", EASY_TASK);
      expect(rec.estimated).toBeLessThanOrEqual(budget);
    }
  });

  it("prefers a cheaper model for a hard task when minimizing cost", () => {
    const cheap = selectModel(hard, 40, "minimize-cost", HARD_TASK);
    const quality = selectModel(hard, 40, "maximum-quality", HARD_TASK);
    expect(cheap.estimated).toBeLessThanOrEqual(quality.estimated);
  });

  it("selects a viable model for a very complex task", () => {
    const rec = selectModel(hard, 100, "balanced", HARD_TASK);
    const model = getModel(rec.modelId)!;
    expect(model.codingCapability).toBeGreaterThanOrEqual(75);
  });

  it("builds a comparison containing the recommendation", () => {
    const rec = selectModel(easy, 10, "balanced", EASY_TASK);
    const rows = buildComparison(easy, "balanced", rec, EASY_TASK);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.modelId)).toContain(rec.modelId);
  });

  it("frames the recommendation relative to the task", () => {
    const rec = selectModel(easy, 10, "balanced", EASY_TASK);
    expect(rec.reasons.join(" ").toLowerCase()).toContain("task");
  });

  /**
   * The original request must drive pricing, not the LLM summary.
   *
   * These two descriptions differ hugely in scope but can produce a similar
   * one-sentence summary. Pricing from the summary would flatten them; pricing
   * from the request must not.
   */
  it("prices from the original task rather than the compressed summary", () => {
    const detailed = selectModel(hard, 100, "balanced", HARD_TASK);
    const vague = selectModel(easy, 100, "balanced", EASY_TASK);
    expect(detailed.estimated).toBeGreaterThan(vague.estimated);
  });
});