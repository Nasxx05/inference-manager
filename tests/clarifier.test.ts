import { describe, expect, it } from "vitest";
import {
  CORE_BY_TYPE,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
  TRIGGERED_SETS,
  answersUsed,
  resolveAnswers,
  selectQuestions,
} from "@/lib/clarifier";
import type { TaskType } from "@/types";

const ALL_TYPES: TaskType[] = [
  "coding",
  "web-development",
  "research",
  "writing",
  "document-analysis",
  "data-analysis",
  "planning",
  "creative",
  "general",
];

describe("question bank", () => {
  it("has a core set for every task type", () => {
    for (const type of ALL_TYPES) {
      expect(CORE_BY_TYPE[type], type).toBeDefined();
      expect(CORE_BY_TYPE[type].length, type).toBeGreaterThan(0);
    }
  });

  it("gives every question a non-empty default so skipping is safe", () => {
    const all = [
      ...ALL_TYPES.flatMap((type) => CORE_BY_TYPE[type]),
      ...TRIGGERED_SETS.flatMap((set) => set.questions),
    ];
    for (const question of all) {
      expect(question.id.trim(), question.id).not.toBe("");
      expect(question.question.trim(), question.id).not.toBe("");
      expect(question.defaultValue.trim(), question.id).not.toBe("");
    }
  });

  it("never repeats a question id within one set", () => {
    for (const type of ALL_TYPES) {
      const ids = CORE_BY_TYPE[type].map((q) => q.id);
      expect(new Set(ids).size, type).toBe(ids.length);
    }
    for (const set of TRIGGERED_SETS) {
      const ids = set.questions.map((q) => q.id);
      expect(new Set(ids).size, set.id).toBe(ids.length);
    }
  });
});

describe("selectQuestions", () => {
  it("asks different questions for a portfolio site than for a game", () => {
    const portfolio = selectQuestions("build a portfolio website", "web-development");
    const game = selectQuestions("build a tic-tac-toe game", "coding");

    const portfolioIds = portfolio.map((q) => q.id);
    const gameIds = game.map((q) => q.id);

    expect(portfolioIds).toContain("purpose");
    expect(portfolioIds).toContain("design");
    expect(portfolioIds).toContain("sections");
    expect(portfolioIds).not.toContain("game_mode");

    expect(gameIds).toContain("game_mode");
    expect(gameIds).toContain("game_rules");
    expect(gameIds).not.toContain("purpose");
  });

  it("asks about win and draw handling for a game", () => {
    const game = selectQuestions("build a tic-tac-toe game", "coding");
    const rules = game.find((q) => q.id === "game_rules");
    expect(rules).toBeDefined();
    expect(rules?.question.toLowerCase()).toContain("draw");
  });

  it("asks about single or two player mode for a game", () => {
    const game = selectQuestions("make a chess game", "coding");
    const mode = game.find((q) => q.id === "game_mode");
    expect(mode).toBeDefined();
    expect(mode?.question.toLowerCase()).toContain("multiplayer");
  });

  it("asks about audience and pages for a portfolio website", () => {
    const site = selectQuestions("build a portfolio website", "web-development");
    const text = site.map((q) => q.question.toLowerCase()).join(" ");
    expect(text).toContain("who is this for");
    expect(text).toContain("pages or sections");
    expect(text).toContain("tech stack");
  });

  it("fires the api set for a backend service", () => {
    const api = selectQuestions("build a REST API for a todo service", "coding");
    expect(api.map((q) => q.id)).toContain("api_style");
  });

  it("fires the auth set for a login flow", () => {
    const auth = selectQuestions("add user login and signup", "coding");
    expect(auth.map((q) => q.id)).toContain("auth_method");
  });

  it("fires the ecommerce set for a store", () => {
    const shop = selectQuestions("build an online store with a cart", "web-development");
    expect(shop.map((q) => q.id)).toContain("checkout");
  });

  it("does not fire the game set for an unrelated task", () => {
    const research = selectQuestions("research the history of the printing press", "research");
    expect(research.map((q) => q.id)).not.toContain("game_mode");
  });

  it("stays within the question count bounds for every task type", () => {
    for (const type of ALL_TYPES) {
      const questions = selectQuestions("build a tic-tac-toe game with a database", type);
      expect(questions.length, type).toBeGreaterThanOrEqual(MIN_QUESTIONS);
      expect(questions.length, type).toBeLessThanOrEqual(MAX_QUESTIONS);
    }
  });

  it("never returns duplicate ids", () => {
    const questions = selectQuestions("build an online store with login and a database", "coding");
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveAnswers", () => {
  const questions = selectQuestions("build a tic-tac-toe game", "coding");

  it("marks answered questions as answered", () => {
    const answers = resolveAnswers(questions, { game_mode: "Two players on the same device" });
    const mode = answers.find((a) => a.id === "game_mode");
    expect(mode?.answered).toBe(true);
    expect(mode?.answer).toBe("Two players on the same device");
  });

  it("falls back to the default when a question is skipped", () => {
    const answers = resolveAnswers(questions, {});
    expect(answers).toHaveLength(questions.length);
    for (const answer of answers) {
      expect(answer.answered).toBe(false);
      expect(answer.answer.trim()).not.toBe("");
    }
  });

  it("treats whitespace-only answers as skipped", () => {
    const answers = resolveAnswers(questions, { game_mode: "   " });
    const mode = answers.find((a) => a.id === "game_mode");
    expect(mode?.answered).toBe(false);
  });

  it("falls back to the default for an unknown question id", () => {
    const answers = resolveAnswers(questions, { not_a_real_id: "ignored" });
    expect(answers).toHaveLength(questions.length);
    expect(answers.some((a) => a.id === "not_a_real_id")).toBe(false);
  });

  it("trims submitted answers", () => {
    const answers = resolveAnswers(questions, { game_mode: "  Two players  " });
    expect(answers.find((a) => a.id === "game_mode")?.answer).toBe("Two players");
  });

  it("handles a missing responses object", () => {
    const answers = resolveAnswers(questions, undefined);
    expect(answers).toHaveLength(questions.length);
    expect(answersUsed(answers)).toBe(false);
  });

  it("returns an empty list when no questions were shown", () => {
    expect(resolveAnswers([], { anything: "value" })).toEqual([]);
    expect(answersUsed([])).toBe(false);
  });
});

describe("answersUsed", () => {
  const questions = selectQuestions("build a tic-tac-toe game", "coding");

  it("is true when at least one question was answered", () => {
    expect(answersUsed(resolveAnswers(questions, { game_mode: "Two players" }))).toBe(true);
  });

  it("is false when every question was skipped", () => {
    expect(answersUsed(resolveAnswers(questions, {}))).toBe(false);
  });
});