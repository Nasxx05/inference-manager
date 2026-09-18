import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { findModelOrThrow } from "@/data/models";
import { compilePrompt, requiredSectionsPresent } from "@/lib/promptCompiler/promptCompiler";
import { optimizeScope } from "@/lib/scopeOptimizer/scopeOptimizer";
import type { TaskAnalysis } from "@/types";

const task = "Build a responsive SaaS landing page using Next.js, TypeScript and Tailwind with pricing, testimonials and a contact form.";
const analysis = heuristicAnalyze(task);
const model = findModelOrThrow("claude-sonnet");

function compile(overrides: Partial<Parameters<typeof compilePrompt>[0]> = {}) {
  return compilePrompt({
    taskDescription: task,
    analysis,
    model,
    budget: 10,
    optimization: "balanced",
    scopeApplied: false,
    optimizedScope: null,
    costRange: { minimum: 5.7, maximum: 7.2, recommendedMaximum: 8 },
    ...overrides,
  });
}

describe("prompt compiler", () => {
  it("includes every required section", () => {
    const prompt = compile();
    expect(requiredSectionsPresent(prompt)).toBe(true);
  });

  it("describes the budget as a planning constraint", () => {
    const prompt = compile();
    expect(prompt).toContain("10 CREDIT");
    expect(prompt).toContain("BUDGET CONSTRAINT");
    expect(prompt).toContain("targeted corrections");
    expect(prompt).not.toContain("wallet");
    expect(prompt).not.toContain("billing system");
    expect(prompt).not.toContain("seed phrase");
  });

  it("carries the task context into the prompt", () => {
    const prompt = compile();
    expect(prompt).toContain("Next.js");
    expect(prompt).toContain(analysis.summary);
  });

  it("keeps dotted technology names intact in requirements", () => {
    const prompt = compile();
    expect(prompt).toContain("Next.js");
    expect(prompt).not.toMatch(/- Next\s*$/m);
  });

  it("derives requirements from the user request, not internal phase names", () => {
    const prompt = compile();
    const requirementsBlock = prompt.split("REQUIREMENTS")[1].split("SCOPE")[0];
    expect(requirementsBlock).toContain("Pricing");
    expect(requirementsBlock).toContain("contact form");
  });

  it("keeps REQUIREMENTS and SCOPE distinct", () => {
    const prompt = compile();
    const requirements = prompt.split("REQUIREMENTS")[1].split("SCOPE")[0].trim();
    const scope = prompt.split("SCOPE")[1].split("OUT OF SCOPE")[0].trim();
    expect(requirements).not.toBe(scope);
  });

  it("is model-aware", () => {
    const prompt = compile();
    expect(prompt).toContain(model.displayName);
  });

  it("reflects the optimized scope when applied", () => {
    const scope = optimizeScope(analysis, 3);
    const prompt = compile({ scopeApplied: true, optimizedScope: scope });
    expect(prompt).toContain("OUT OF SCOPE");
    for (const item of scope.included.slice(0, 2)) {
      expect(prompt).toContain(item.split(":")[0]);
    }
  });

  it("stays focused rather than gigantic", () => {
    const prompt = compile();
    expect(prompt.length).toBeLessThan(6000);
  });

  it("emits each section header exactly once", () => {
    const prompt = compile();
    const lines = prompt.split("\n");
    const headers = ["ROLE", "OBJECTIVE", "CONTEXT", "REQUIREMENTS", "SCOPE", "OUT OF SCOPE", "PRIORITIES", "EXECUTION STRATEGY", "CONSTRAINTS", "BUDGET CONSTRAINT", "VALIDATION", "REVISION POLICY", "STOPPING CONDITIONS", "OUTPUT FORMAT"];

    for (const header of headers) {
      const count = lines.filter((line) => line.trim() === header).length;
      expect(count).toBe(1);
    }
  });

  it("handles a minimal analysis without throwing", () => {
    const minimal: TaskAnalysis = {
      ...analysis,
      phases: [],
      risks: [],
      scopeAdjustments: [],
      toolRequirements: [],
      requiredCapabilities: [],
    };
    const prompt = compile({ analysis: minimal });
    expect(requiredSectionsPresent(prompt)).toBe(true);
  });
});