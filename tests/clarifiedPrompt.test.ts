import { describe, expect, it } from "vitest";
import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { findModelOrThrow } from "@/data/models";
import { selectQuestions, resolveAnswers } from "@/lib/clarifier";
import {
  answeredRequirements,
  appliedDefaults,
  compilePrompt,
  hasBuildStructure,
  requiredSectionsPresent,
} from "@/lib/promptCompiler/promptCompiler";
import type { ClarifyingAnswer } from "@/types";

const model = findModelOrThrow("claude-sonnet");

function compileFor(task: string, responses: Record<string, string>, skipped = false) {
  const analysis = heuristicAnalyze(task);
  const questions = selectQuestions(task, analysis.taskType);
  const answers = resolveAnswers(questions, skipped ? {} : responses);

  const prompt = compilePrompt({
    taskDescription: task,
    analysis,
    model,
    budget: 10,
    optimization: "balanced",
    scopeApplied: false,
    optimizedScope: null,
    clarifyingAnswers: answers,
    costRange: { minimum: 5.7, maximum: 7.2, recommendedMaximum: 8 },
  });

  return { prompt, answers, analysis, questions };
}

describe("clarified prompt", () => {
  it("folds answered questions into the prompt as binding requirements", () => {
    const { prompt } = compileFor("build a tic-tac-toe game", {
      game_mode: "Two players on the same device",
    });
    expect(prompt).toContain("Confirmed by the requester");
    expect(prompt).toContain("Two players on the same device");
  });

  it("records skipped questions as assumed defaults", () => {
    const { prompt } = compileFor("build a tic-tac-toe game", {}, true);
    expect(prompt).toContain("ASSUMED DEFAULTS");
    expect(prompt).toContain("assumed:");
  });

  it("still produces a usable prompt when everything is skipped", () => {
    const { prompt, answers } = compileFor("build a tic-tac-toe game", {}, true);
    expect(requiredSectionsPresent(prompt)).toBe(true);
    expect(prompt.trim().length).toBeGreaterThan(200);
    for (const answer of answers) {
      expect(answer.answered).toBe(false);
      expect(prompt).toContain(answer.answer);
    }
  });

  it("carries specific answered detail that a skipped run does not contain", () => {
    const answered = compileFor("build a portfolio website", {
      purpose: "Freelance designer showcasing case studies",
      sections: "Home, work, about, contact",
    }).prompt;
    const skipped = compileFor("build a portfolio website", {}, true).prompt;

    expect(answered).toContain("Freelance designer showcasing case studies");
    expect(skipped).not.toContain("Freelance designer showcasing case studies");
    expect(answered).toContain("Confirmed by the requester");
  });

  it("marks skipped answers as assumptions rather than confirmed requirements", () => {
    const { prompt } = compileFor("build a portfolio website", {}, true);
    expect(prompt).not.toContain("Confirmed by the requester");
    expect(prompt).toContain("ASSUMED DEFAULTS");
  });

  it("states what to build, how to achieve it, and the structure to follow", () => {
    const { prompt } = compileFor("build a portfolio website", {
      purpose: "Freelance designer showcasing case studies",
      sections: "Home, work, about, contact",
    });

    expect(prompt).toContain("OBJECTIVE");
    expect(prompt).toContain("STRUCTURE AND ARCHITECTURE");
    expect(prompt).toContain("Follow this page and section order: Home, work, about, contact.");
    expect(prompt).toContain("components");
  });

  it("adds structure guidance for build tasks even when skipped", () => {
    const { prompt } = compileFor("build a tic-tac-toe game", {}, true);
    expect(hasBuildStructure(prompt)).toBe(true);
  });

  it("does not add structure guidance for non-build tasks", () => {
    const { prompt } = compileFor("research the history of the printing press", {}, true);
    expect(hasBuildStructure(prompt)).toBe(false);
    expect(requiredSectionsPresent(prompt)).toBe(true);
  });

  it("tells the executor to restate assumed defaults so they can be corrected", () => {
    const { prompt } = compileFor("build a tic-tac-toe game", {}, true);
    expect(prompt).toContain("List the assumed defaults you applied");
  });

  it("separates answered requirements from assumed defaults", () => {
    const answers: ClarifyingAnswer[] = [
      { id: "a", question: "Which stack?", answer: "Next.js", answered: true },
      { id: "b", question: "Which style?", answer: "Minimal", answered: false },
      { id: "c", question: "Which tone?", answer: "   ", answered: true },
    ];
    expect(answeredRequirements(answers)).toEqual(["Which stack? -> Next.js"]);
    expect(appliedDefaults(answers)).toEqual(["Which style? -> assumed: Minimal"]);
  });

  it("keeps every required section when answers are present", () => {
    const { prompt } = compileFor("build a portfolio website", {
      purpose: "Freelance designer",
      stack: "Next.js + TypeScript + Tailwind",
      design: "Minimal and editorial",
      sections: "Home, work, about, contact",
    });
    expect(requiredSectionsPresent(prompt)).toBe(true);
  });

  it("stays within a reasonable size with all questions answered", () => {
    const { prompt } = compileFor("build a portfolio website", {
      purpose: "Freelance designer showcasing case studies",
      stack: "Next.js + TypeScript + Tailwind",
      design: "Minimal and editorial",
      sections: "Home, work, about, contact",
      features: "Responsive mobile layout",
    });
    expect(prompt.length).toBeLessThan(8000);
  });
});