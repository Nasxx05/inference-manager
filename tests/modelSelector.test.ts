import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { MODELS, getModel } from "@/data/models";
import { buildComparison, selectModel } from "@/lib/models/modelSelector";

const easy = heuristicAnalyze("Write a short thank-you email to a client.");
const hard = heuristicAnalyze(
  "Build a complete production-ready ecommerce platform with authentication, payments, admin dashboard, real-time inventory and analytics.",
);

describe("model selector", () => {
  it("selects a known model with reasons", () => {
    const rec = selectModel(easy, 10, "balanced");
    expect(getModel(rec.modelId)).toBeDefined();
    expect(rec.reasons.length).toBeGreaterThan(0);
    expect(rec.estimated).toBeGreaterThan(0);
  });

  it("does not always pick the cheapest model", () => {
    const rec = selectModel(hard, 50, "balanced");
    const cheapest = [...MODELS].sort(
      (a, b) => a.inputPrice + a.outputPrice - (b.inputPrice + b.outputPrice),
    )[0];
    expect(rec.modelId).not.toBe(cheapest.id);
  });

  it("never recommends a model over budget as the estimate grows", () => {
    for (const budget of [2, 5, 10, 50]) {
      const rec = selectModel(easy, budget, "minimize-cost");
      expect(rec.estimated).toBeLessThanOrEqual(budget);
    }
  });

  it("prefers a cheaper model for a hard task when minimizing cost", () => {
    const cheap = selectModel(hard, 40, "minimize-cost");
    const quality = selectModel(hard, 40, "maximum-quality");
    expect(cheap.estimated).toBeLessThanOrEqual(quality.estimated);
  });

  it("selects a viable model for a very complex task", () => {
    const rec = selectModel(hard, 100, "balanced");
    const model = getModel(rec.modelId)!;
    expect(model.codingCapability).toBeGreaterThanOrEqual(75);
  });

  it("builds a comparison containing the recommendation", () => {
    const rec = selectModel(easy, 10, "balanced");
    const rows = buildComparison(easy, "balanced", rec);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.modelId)).toContain(rec.modelId);
  });

  it("frames the recommendation relative to the task", () => {
    const rec = selectModel(easy, 10, "balanced");
    expect(rec.reasons.join(" ").toLowerCase()).toContain("task");
  });
});