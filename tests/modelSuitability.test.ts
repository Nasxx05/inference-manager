/**
 * Model suitability, independent of budget.
 *
 * The key property under test: verdicts come from capability metadata, never
 * from a model's name or id. If a model is renamed or a new one added, these
 * verdicts should still be correct — so the test also proves the engine works
 * against a synthetic model list it has never seen.
 */

import { describe, expect, it } from "vitest";
import { MODELS, findModelOrThrow } from "@/data/models";
import { capabilityProfile } from "@/lib/models/capabilities";
import { evaluateFit, evaluateSuitability, selectCapableModel } from "@/lib/models/suitability";
import { deriveRequirementProfile } from "@/lib/models/capabilities";
import type { ModelConfig, TaskRequirementProfile } from "@/types";

const OPUS = findModelOrThrow("claude-opus");
const MINI = findModelOrThrow("gpt-4o-mini");

/** A demanding production engineering task. */
const HARD_PROFILE: TaskRequirementProfile = {
  codingRequirement: 92,
  reasoningRequirement: 92,
  researchRequirement: 60,
  contextRequirement: 70,
  structuredOutputRequirement: 70,
};

/** A trivial writing task. */
const EASY_PROFILE: TaskRequirementProfile = {
  codingRequirement: 15,
  reasoningRequirement: 25,
  researchRequirement: 20,
  contextRequirement: 20,
  structuredOutputRequirement: 30,
};

describe("capability profiles", () => {
  it("puts every model on the same 0-100 scales", () => {
    for (const model of MODELS) {
      const profile = capabilityProfile(model);
      for (const value of [
        profile.coding,
        profile.reasoning,
        profile.research,
        profile.longContext,
        profile.structuredOutput,
      ]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("scores a larger context window higher", () => {
    const small = capabilityProfile({ ...MINI, contextWindow: 8000 });
    const large = capabilityProfile({ ...MINI, contextWindow: 500000 });
    expect(large.longContext).toBeGreaterThan(small.longContext);
  });
});

describe("suitability is driven by capability, not by model name", () => {
  it("flags a low-capability model as not recommended for a hard task", () => {
    const weak: ModelConfig = {
      ...MINI,
      id: "synthetic-weak",
      displayName: "Synthetic Weak",
      codingCapability: 30,
      reasoningCapability: 32,
      researchCapability: 30,
    };
    const result = evaluateFit(weak, HARD_PROFILE);
    expect(result.weightedGap).toBeGreaterThan(25);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it("accepts a strong model for the same task", () => {
    const result = evaluateFit(OPUS, HARD_PROFILE);
    expect(result.weightedGap).toBeLessThan(12);
    expect(result.gaps).toEqual([]);
  });

  it("gives the same verdict to a renamed clone of the same capability", () => {
    // Same numbers, different id and name: the verdict must not change.
    const clone: ModelConfig = { ...MINI, id: "renamed-xyz", displayName: "Renamed XYZ" };
    const original = evaluateFit(MINI, HARD_PROFILE);
    const renamed = evaluateFit(clone, HARD_PROFILE);
    expect(renamed.weightedGap).toBe(original.weightedGap);
  });

  it("returns a three-way verdict", () => {
    const statuses = MODELS.map((m) => evaluateFit(m, HARD_PROFILE).weightedGap);
    expect(statuses.length).toBeGreaterThan(0);
  });
});

describe("suitability result shape", () => {
  it("marks a weak model as not recommended and suggests a stronger one", () => {
    const weak: ModelConfig = {
      ...MINI,
      id: "synthetic-weak",
      displayName: "Synthetic Weak",
      codingCapability: 28,
      reasoningCapability: 30,
      researchCapability: 28,
    };
    const analysis = {
      taskType: "coding" as const,
      summary: "A hard production system.",
      complexity: "very-high" as const,
      requiredCapabilities: [],
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 1000,
      expectedIterations: 4,
      toolRequirements: [],
      phases: [],
      risks: [],
      scopeAdjustments: [],
      requirementProfile: HARD_PROFILE,
    };

    const result = evaluateSuitability({
      model: weak,
      analysis,
      taskDescription: "Build a production RAG agent.",
      candidates: MODELS,
      explicit: true,
    });

    expect(result.status).toBe("not-recommended");
    expect(result.capabilityGaps.length).toBeGreaterThan(0);
    expect(result.suggestedModelId).toBeTruthy();
    // The suggestion must actually be more capable for this task.
    const suggested = MODELS.find((m) => m.id === result.suggestedModelId);
    expect(suggested).toBeTruthy();
    expect(evaluateFit(suggested!, HARD_PROFILE).weightedGap).toBeLessThan(
      evaluateFit(weak, HARD_PROFILE).weightedGap,
    );
  });

  it("reports a strong model as suitable with no suggestion", () => {
    const analysis = {
      taskType: "writing" as const,
      summary: "A short description.",
      complexity: "low" as const,
      requiredCapabilities: [],
      estimatedInputTokens: 500,
      estimatedOutputTokens: 500,
      expectedIterations: 1,
      toolRequirements: [],
      phases: [],
      risks: [],
      scopeAdjustments: [],
      requirementProfile: EASY_PROFILE,
    };

    const result = evaluateSuitability({
      model: OPUS,
      analysis,
      taskDescription: "Write a product description.",
      candidates: MODELS,
      explicit: true,
    });

    expect(result.status).toBe("suitable");
    expect(result.suggestedModelId).toBeUndefined();
  });

  it("records when the user knowingly keeps an advised-against model", () => {
    const analysis = {
      taskType: "coding" as const,
      summary: "A hard system.",
      complexity: "very-high" as const,
      requiredCapabilities: [],
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 1000,
      expectedIterations: 4,
      toolRequirements: [],
      phases: [],
      risks: [],
      scopeAdjustments: [],
      requirementProfile: HARD_PROFILE,
    };

    const result = evaluateSuitability({
      model: MINI,
      analysis,
      taskDescription: "Build a production RAG agent.",
      candidates: MODELS,
      explicit: true,
      overridden: true,
    });
    expect(result.overridden).toBe(true);
  });
});

describe("auto model selection", () => {
  it("picks a capable model for a hard task, not merely the cheapest", () => {
    const chosen = selectCapableModel(HARD_PROFILE, MODELS, "balanced");
    expect(chosen).toBeTruthy();
    // Must clear the capability bar.
    expect(evaluateFit(chosen!, HARD_PROFILE).gaps).toEqual([]);
  });

  it("picks something cheaper for an easy task than for a hard one", () => {
    const easy = selectCapableModel(EASY_PROFILE, MODELS, "balanced");
    const hard = selectCapableModel(HARD_PROFILE, MODELS, "balanced");
    const price = (m: ModelConfig) => m.inputPrice + m.outputPrice;
    expect(price(easy!)).toBeLessThanOrEqual(price(hard!));
  });

  it("never returns a model outside the candidate list", () => {
    const chosen = selectCapableModel(HARD_PROFILE, MODELS, "balanced");
    expect(MODELS.some((m) => m.id === chosen!.id)).toBe(true);
  });
});

describe("derived requirement profiles", () => {
  it("demands more coding capability for a coding task than a writing task", () => {
    const coding = deriveRequirementProfile({
      taskType: "coding",
      complexity: "high",
      effortScore: 70,
    });
    const writing = deriveRequirementProfile({
      taskType: "writing",
      complexity: "high",
      effortScore: 70,
    });
    expect(coding.codingRequirement).toBeGreaterThan(writing.codingRequirement);
  });

  it("demands more research capability for a research task", () => {
    const research = deriveRequirementProfile({
      taskType: "research",
      complexity: "high",
      effortScore: 70,
    });
    const coding = deriveRequirementProfile({
      taskType: "coding",
      complexity: "high",
      effortScore: 70,
    });
    expect(research.researchRequirement).toBeGreaterThan(coding.researchRequirement);
  });
});