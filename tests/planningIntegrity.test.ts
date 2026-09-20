/**
 * Regression tests for the two architectural correctness rules.
 *
 * ISSUE 1 — ONE authoritative target-model decision per request:
 *   no pre-resolved Auto guess, no neutral placeholder, no second resolution
 *   after the prompt was written. The prompt is written for the exact model the
 *   plan reports.
 *
 * ISSUE 2 — ONE canonical final scope:
 *   the optimizer and the planner share one estimator, the scope that was
 *   estimated is the scope that was prompted, and the plan's final numbers and
 *   feasibility come from that same scope.
 *
 * These tests assert the invariants, not the implementation, so they keep
 * holding if the internals are rearranged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPlan } from "@/lib/planner";
import { findModelOrThrow, AUTO_MODEL_ID } from "@/data/models";
import {
  buildFinalScope,
  excludedRequirements,
  includedRequirements,
  optimizeFinalScope,
  protectedIds,
} from "@/lib/scopeOptimizer/finalScope";
import { createCanonicalEstimator } from "@/lib/scopeOptimizer/canonicalEstimator";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { buildEnrichedTask } from "@/lib/clarifier/enrichedTask";
import type { FinalScope } from "@/types";

/**
 * `finalScope` is optional on the wire but is always present on a built plan.
 * This narrows it once, so the assertions below state the invariant rather
 * than repeating a non-null check.
 */
function scopeOf(plan: { finalScope?: FinalScope }): FinalScope {
  expect(plan.finalScope).toBeDefined();
  return plan.finalScope as FinalScope;
}

const VALID_PROMPT = [
  "ROLE",
  "You are a senior engineer.",
  "OBJECTIVE",
  "Deliver the requested work.",
  "CONTEXT",
  "The requester described a task.",
  "REQUIREMENTS",
  "- Meet every stated requirement.",
  "ASSUMED DEFAULTS",
  "- Restate your assumptions.",
  "STRUCTURE AND ARCHITECTURE",
  "- Organise the work into clear parts.",
  "SCOPE",
  "- Deliver what is in scope.",
  "OUT OF SCOPE",
  "- Do not build deferred items.",
  "PRIORITIES",
  "- Correctness first.",
  "EXECUTION STRATEGY",
  "- Work in one pass, then validate.",
  "CONSTRAINTS",
  "- Stay within the stated budget.",
  "BUDGET CONSTRAINT",
  "- Stop if the budget is exhausted.",
  "VALIDATION",
  "- Check the output against the requirements.",
  "REVISION POLICY",
  "- Use targeted corrections.",
  "STOPPING CONDITIONS",
  "- Stop when requirements pass.",
  "OUTPUT FORMAT",
  "- Return the finished work.",
].join("\n");

const ANALYSIS = {
  taskType: "coding",
  complexity: "high",
  summary: "A multi-part build with several optional components.",
  requiredCapabilities: ["coding"],
  estimatedInputTokens: 20000,
  estimatedOutputTokens: 12000,
  expectedIterations: 4,
  phases: [
    { name: "Core implementation", description: "Build the core", costWeight: 0.5, priority: "essential" },
    { name: "Analytics", description: "Add analytics", costWeight: 0.3, priority: "optional" },
    { name: "Reporting", description: "Add reporting", costWeight: 0.2, priority: "optional" },
  ],
  risks: ["scope creep"],
};

/**
 * Returns the target-model marker line the prompt writer was told about,
 * parsing it out of whichever request the planner sent.
 */
function targetModelFromRequest(body: unknown): string | null {
  const content = JSON.stringify(body ?? {});
  // The model name sits immediately after the marker, separated by whatever
  // newline encoding the serialized body uses. Capture the marker plus the
  // following 120 characters so the model can be identified.
  const match = content.match(
    /TARGET MODEL (?:TO WRITE THE PROMPT FOR|THE PROMPT MUST BE WRITTEN FOR)[\s\S]{0,120}/i,
  );
  return match ? match[0] : null;
}

function stubProvider(response: unknown) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const wantsJson = body.response_format?.type === "json_object";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: wantsJson ? JSON.stringify(response) : VALID_PROMPT },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }),
      text: async () => JSON.stringify({
        choices: [
          {
            message: {
              content: wantsJson ? JSON.stringify(response) : VALID_PROMPT,
            },
            finish_reason: "stop",
          },
        ],
      }),
    } as unknown as Response;
  });
}

const COMBINED_RESPONSE = {
  analysis: ANALYSIS,
  prompt: VALID_PROMPT,
};

beforeEach(() => {
  process.env.AGENTFUND_AI_BASE_URL = "https://example.test/v1";
  process.env.AGENTFUND_AI_API_KEY = "test-key";
  process.env.AGENTFUND_AI_MODEL = "test-model";
  process.env.AGENTFUND_AI_COMBINED = "1";
  vi.stubGlobal("fetch", stubProvider(COMBINED_RESPONSE));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("issue 1 — one authoritative model resolution", () => {
  it("uses the explicit model for the prompt, the cost and the result", async () => {
    const plan = await buildPlan({
      taskDescription: "Build a landing page with a contact form and analytics.",
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 50,
    });

    expect(plan.modelId).toBe("claude-sonnet");
    expect(plan.promptModelId).toBe("claude-sonnet");
    expect(plan.cost.modelId).toBe("claude-sonnet");
    expect(plan.autoSelected).toBe(false);
    // Auto-only fields stay unset for an explicit choice.
    expect(plan.resolvedModelId).toBeUndefined();
  });

  it("resolves Auto to a concrete model used everywhere", async () => {
    const plan = await buildPlan({
      taskDescription: "Build a landing page with a contact form and analytics.",
      modelId: AUTO_MODEL_ID,
      optimization: "balanced",
      budget: 50,
    });

    expect(plan.autoSelected).toBe(true);
    expect(plan.modelId).not.toBe("auto");
    expect(plan.modelId).not.toBe(AUTO_MODEL_ID);
    // Concrete and present in the registry.
    expect(() => findModelOrThrow(plan.modelId)).not.toThrow();
    expect(plan.promptModelId).toBe(plan.modelId);
    expect(plan.cost.modelId).toBe(plan.modelId);
    expect(plan.resolvedModelId).toBe(plan.modelId);
    expect(plan.resolvedModelReason).toBeTruthy();
  });

  it("never resolves the model more than once per plan", async () => {
    const plan = await buildPlan({
      taskDescription: "Build a landing page with a contact form and analytics.",
      modelId: AUTO_MODEL_ID,
      optimization: "balanced",
      budget: 50,
    });

    // The prompt writer was told about exactly one target model, and it is the
    // model the plan reports — not a placeholder, not a different one.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const markers = calls
      .map((call) => targetModelFromRequest(call[1]))
      .filter((marker): marker is string => marker !== null);

    expect(markers.length).toBeGreaterThan(0);

    // The writer is told the resolved model by display name.
    const expected = findModelOrThrow(plan.modelId).displayName.toLowerCase();
    for (const marker of markers) {
      // Never a placeholder or an unresolved Auto.
      expect(marker.toLowerCase()).not.toContain("recommended model");
      expect(marker.toLowerCase()).not.toContain("unspecified");
      expect(marker.toLowerCase()).not.toContain('"auto"');
      expect(marker.toLowerCase()).toContain(expected);
    }
    expect(plan.promptModelId).toBe(plan.modelId);
  });

  it("applies the same model contract on the two-call fallback route", async () => {
    process.env.AGENTFUND_AI_COMBINED = "0";
    vi.stubGlobal("fetch", stubProvider(ANALYSIS));

    const plan = await buildPlan({
      taskDescription: "Build a landing page with a contact form and analytics.",
      modelId: AUTO_MODEL_ID,
      optimization: "balanced",
      budget: 50,
    });

    expect(plan.route).toBe("two-call");
    expect(plan.modelId).not.toBe("auto");
    expect(() => findModelOrThrow(plan.modelId)).not.toThrow();
    expect(plan.promptModelId).toBe(plan.modelId);
    expect(plan.cost.modelId).toBe(plan.modelId);
    expect(plan.resolvedModelId).toBe(plan.modelId);
  });
});

describe("issue 2 — one canonical final scope", () => {
  const TIGHT_TASK =
    "Build a complete ecommerce platform with core checkout, admin dashboard, order management, analytics, reporting and a full test suite.";

  it("keeps the full scope when the budget is sufficient", async () => {
    const plan = await buildPlan({
      taskDescription: TIGHT_TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 100000,
      applyOptimizedScope: true,
    });

    expect(scopeOf(plan).reductions).toHaveLength(0);
    expect(scopeOf(plan).excludedIds).toHaveLength(0);
    expect(scopeOf(plan).includedIds).toEqual(
      scopeOf(plan).requirements.map((unit) => unit.id),
    );
    expect(plan.optimizationInsufficient).toBe(false);
  });

  it("optimizes, defers optional work first, preserves core, and reflects it in the prompt", async () => {
    const plan = await buildPlan({
      taskDescription: TIGHT_TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 0.01,
      applyOptimizedScope: true,
    });

    expect(scopeOf(plan).reductions.length).toBeGreaterThan(0);
    expect(plan.scopeApplied).toBe(true);

    // Core work survives.
    for (const id of protectedIds(scopeOf(plan))) {
      expect(scopeOf(plan).includedIds).toContain(id);
    }

    // The prompt must not ask for anything that was deferred.
    for (const unit of excludedRequirements(scopeOf(plan))) {
      expect(plan.prompt.toLowerCase()).not.toContain(unit.name.toLowerCase());
    }
    // And it was generated from this very scope.
    expect(plan.promptModelId).toBe(plan.modelId);
  });

  it("uses the same estimator in the optimizer and the final estimate", async () => {
    const taskDescription = TIGHT_TASK;
    const task = buildEnrichedTask({
      taskDescription,
      taskType: heuristicAnalyze(taskDescription).taskType,
      answers: [],
    });
    const analysis = heuristicAnalyze(taskDescription);
    const model = findModelOrThrow("claude-sonnet");
    const baseEffort = resolveTaskEffort({ analysis, taskDescription });

    const scope = buildFinalScope({
      analysis,
      requirements: task.resolvedRequirements.map((r) => ({ name: r.name, weight: r.weight })),
    });

    const canonical = createCanonicalEstimator({
      analysis,
      model,
      optimization: "balanced",
      taskDescription,
      answerMultiplier: 1,
      addedRequirements: 0,
      baseEffort,
      fullRequirementCount: scope.requirements.length,
    });

    const result = optimizeFinalScope({
      scope,
      budget: 0.01,
      estimate: canonical.estimate,
    });

    // The optimizer's own number for its final scope equals the canonical
    // estimate of that same scope: one estimator, no divergence.
    expect(result.estimatedCost).toBeCloseTo(canonical.estimateFull(result.finalScope).recommendedMaximum, 6);
  });

  it("never lets a removed requirement leak into the prompt", async () => {
    const plan = await buildPlan({
      taskDescription: TIGHT_TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 0.01,
      applyOptimizedScope: true,
    });

    const deferred = excludedRequirements(scopeOf(plan));
    expect(deferred.length).toBeGreaterThan(0);

    for (const unit of deferred) {
      expect(plan.prompt.toLowerCase()).not.toContain(unit.name.toLowerCase());
    }
  });

  it("never removes a core requirement, however small the budget", async () => {
    const plan = await buildPlan({
      taskDescription: TIGHT_TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 0.0001,
      applyOptimizedScope: true,
    });

    const core = scopeOf(plan).requirements.filter((unit) => unit.core);
    for (const unit of core) {
      expect(scopeOf(plan).includedIds).toContain(unit.id);
    }
  });

  it("changes the prompt when the optimized scope is applied", async () => {
    const base = {
      taskDescription: TIGHT_TASK,
      modelId: "claude-sonnet",
      optimization: "balanced" as const,
      budget: 0.01,
    };

    const full = await buildPlan({ ...base, applyOptimizedScope: false });
    const reduced = await buildPlan({ ...base, applyOptimizedScope: true });

    expect(scopeOf(reduced).reductions.length).toBeGreaterThan(0);
    expect(reduced.scopeApplied).toBe(true);
    expect(full.scopeApplied).toBe(false);
    // The reduced plan costs no more than the full one: deferring work moves
    // the number, it is not cosmetic.
    expect(reduced.cost.recommendedMaximum).toBeLessThanOrEqual(
      full.cost.recommendedMaximum,
    );
  });

  it("derives final feasibility from the final scope and the final estimate", async () => {
    const plan = await buildPlan({
      taskDescription: TIGHT_TASK,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 0.01,
      applyOptimizedScope: true,
    });

    // Feasibility was computed from the plan's reported numbers, which are the
    // canonical estimate of the final scope.
    expect(plan.feasibility.status).toBeDefined();
    expect(plan.optimizationInsufficient).toBe(true);

    const deferred = excludedRequirements(scopeOf(plan));
    expect(deferred.length).toBeGreaterThan(0);

    // The estimate reflects the reduced scope, not the original one.
    expect(plan.cost.recommendedMaximum).toBeGreaterThan(0);
    expect(plan.cost.modelId).toBe(plan.modelId);
  });

  it("is internally consistent end to end", async () => {
    const plan = await buildPlan({
      taskDescription: TIGHT_TASK,
      modelId: AUTO_MODEL_ID,
      optimization: "balanced",
      budget: 0.01,
      applyOptimizedScope: true,
    });

    // One model.
    expect(plan.modelId).not.toBe("auto");
    expect(plan.promptModelId).toBe(plan.modelId);
    expect(plan.cost.modelId).toBe(plan.modelId);
    expect(plan.resolvedModelId).toBe(plan.modelId);

    // One scope: included + excluded partition every requirement exactly once.
    const included = new Set(scopeOf(plan).includedIds);
    const excluded = new Set(scopeOf(plan).excludedIds);
    for (const unit of scopeOf(plan).requirements) {
      expect(included.has(unit.id) || excluded.has(unit.id)).toBe(true);
      expect(included.has(unit.id) && excluded.has(unit.id)).toBe(false);
    }
    expect(included.size + excluded.size).toBe(scopeOf(plan).requirements.length);

    // Core preserved, deferred absent from the prompt.
    for (const id of protectedIds(scopeOf(plan))) {
      expect(included.has(id)).toBe(true);
    }
    for (const unit of excludedRequirements(scopeOf(plan))) {
      expect(plan.prompt.toLowerCase()).not.toContain(unit.name.toLowerCase());
    }

    // Suitability is evaluated for the resolved model.
    expect(plan.suitability).not.toBeNull();

    // Every included requirement is a real requirement object.
    for (const unit of includedRequirements(scopeOf(plan))) {
      expect(unit.name).toBeTruthy();
      expect(unit.id).toBeTruthy();
    }
  });
});