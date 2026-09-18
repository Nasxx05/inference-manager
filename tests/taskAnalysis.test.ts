import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";

describe("task analysis", () => {
  it("classifies a simple task as low complexity", () => {
    const result = heuristicAnalyze("Write a short thank-you email to a client.");
    expect(result.complexity).toBe("low");
    expect(result.taskType).toBe("writing");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.phases.length).toBeGreaterThan(0);
  });

  it("classifies a medium web task correctly", () => {
    const result = heuristicAnalyze(
      "Build a responsive portfolio website using React and TypeScript with a projects section and contact form.",
    );
    expect(result.taskType).toBe("web-development");
    expect(result.complexity).toBe("medium");
    expect(result.phases.map((p) => p.name)).toContain("Implementation");
  });

  it("classifies a complex platform build as high or very-high", () => {
    const result = heuristicAnalyze(
      "Build a complete ecommerce platform with authentication, payment processing, admin dashboard, order management, real-time inventory, analytics and a full test suite.",
    );
    expect(["high", "very-high"]).toContain(result.complexity);
    expect(result.risks.length).toBeGreaterThan(0);
    expect(result.estimatedOutputTokens).toBeGreaterThan(
      heuristicAnalyze("Write a short thank-you email.").estimatedOutputTokens,
    );
  });

  it("uses research-specific phases for research tasks", () => {
    const result = heuristicAnalyze(
      "Research the market landscape for AI developer tools and compare the main competitors with sources.",
    );
    expect(result.taskType).toBe("research");
    expect(result.phases.map((p) => p.name)).toContain("Source validation");
  });

  it("always produces a well-formed analysis", () => {
    const result = heuristicAnalyze("Do something.");
    expect(result.taskType).toBeTruthy();
    expect(result.complexity).toBeTruthy();
    expect(result.phases.length).toBeGreaterThan(0);
    expect(result.expectedIterations).toBeGreaterThanOrEqual(1);
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
  });
});