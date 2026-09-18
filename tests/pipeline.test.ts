import { beforeEach, describe, expect, it } from "vitest";
import { AUTO_MODEL_ID } from "@/data/models";
import { buildPlan } from "@/lib/planner";
import { requiredSectionsPresent } from "@/lib/promptCompiler/promptCompiler";

beforeEach(() => {
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
});

const LANDING_PAGE =
  "Build a responsive SaaS landing page using Next.js, TypeScript and Tailwind. Include pricing, testimonials, FAQ, responsive navigation and a contact form.";

describe("planning pipeline", () => {
  it("produces a complete plan for a medium task with auto model selection", async () => {
    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: AUTO_MODEL_ID,
      optimization: "balanced",
      budget: 10,
    });

    expect(plan.autoSelected).toBe(true);
    expect(plan.recommendation).not.toBeNull();
    expect(plan.modelId).toBeTruthy();
    expect(plan.cost.minimum).toBeGreaterThan(0);
    expect(plan.cost.maximum).toBeGreaterThan(plan.cost.minimum);
    expect(plan.reserve.recommendedReserve).toBeGreaterThanOrEqual(0);
    expect(plan.analysis.phases.length).toBeGreaterThan(0);
    expect(requiredSectionsPresent(plan.prompt)).toBe(true);
    expect(plan.executionPlan.steps.length).toBeGreaterThan(0);
    expect(plan.comparison.length).toBeGreaterThan(0);
  });

  it("honours an explicitly selected model", async () => {
    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 20,
    });

    expect(plan.modelId).toBe("claude-sonnet");
    expect(plan.autoSelected).toBe(false);
    expect(plan.recommendation).toBeNull();
  });

  it("offers scope optimization for a large task with a small budget", async () => {
    const plan = await buildPlan({
      taskDescription:
        "Build a complete ecommerce platform with authentication, real payment processing, admin dashboard, order management, analytics and a full test suite.",
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 5,
    });

    expect(plan.optimizedScope).not.toBeNull();
    expect(plan.optimizedScope!.included.length).toBeGreaterThan(0);
    expect(plan.optimizedScope!.deferred.length).toBeGreaterThan(0);
    expect(plan.feasibility.status).not.toBe("fits");
  });

  it("lowers the estimate when the optimized scope is applied", async () => {
    const request = {
      taskDescription:
        "Build a complete ecommerce platform with authentication, real payment processing, admin dashboard, order management and analytics.",
      modelId: "claude-sonnet",
      optimization: "balanced" as const,
      budget: 5,
    };

    const original = await buildPlan(request);
    const optimized = await buildPlan({ ...request, applyOptimizedScope: true });

    expect(optimized.scopeApplied).toBe(true);
    expect(optimized.cost.maximum).toBeLessThan(original.cost.maximum);
  });

  it("reports fits for a small task with a large budget", async () => {
    const plan = await buildPlan({
      taskDescription: "Write a short thank-you email to a client.",
      modelId: "gpt-4o-mini",
      optimization: "balanced",
      budget: 50,
    });

    expect(plan.feasibility.status).toBe("fits");
    expect(plan.optimizedScope).toBeNull();
  });

  it("handles a decimal budget", async () => {
    const plan = await buildPlan({
      taskDescription: "Summarize this quarter's sales data and highlight trends.",
      modelId: "gpt-4o-mini",
      optimization: "minimize-cost",
      budget: 2.5,
    });

    expect(plan.budget).toBe(2.5);
    expect(Number.isFinite(plan.cost.minimum)).toBe(true);
  });

  it("generates a prompt that mentions the budget and never claims to execute", async () => {
    const plan = await buildPlan({
      taskDescription: LANDING_PAGE,
      modelId: "claude-sonnet",
      optimization: "balanced",
      budget: 10,
    });

    expect(plan.prompt).toContain("CREDIT");
    expect(plan.prompt.toLowerCase()).not.toContain("run with orbio");
  });
});