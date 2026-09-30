import { describe, expect, it } from "vitest";
import {
  DisabledRepositoryTestRunner,
  discoverNodeTestCommands,
} from "../server/src/repositoryTestRunner";

const snapshot = {
  repositoryUrl: "https://github.com/example/app",
  owner: "example",
  name: "app",
  branch: "main",
  commitSha: "abc123",
  reviewedAt: "2026-09-30T00:00:00.000Z",
  fileCount: 3,
  relevantFiles: ["package.json"],
  structuralSummary: "Node project",
  evidenceText: "--- UNTRUSTED REPOSITORY DATA: package.json ---\n{\"scripts\":{\"test\":\"vitest\",\"lint\":\"eslint .\",\"deploy\":\"danger\"}}",
  status: "reviewed" as const,
};

describe("safe repository test runner", () => {
  it("discovers only supported existing package scripts", () => {
    expect(discoverNodeTestCommands(snapshot.evidenceText)).toEqual([
      "npm test",
      "npm run lint",
    ]);
  });

  it("does not execute repository code when no isolated runner exists", async () => {
    const runner = new DisabledRepositoryTestRunner();
    const result = await runner.run({
      projectId: "project-1",
      snapshot,
      commands: ["npm test"],
      explicitlyAuthorized: true,
    });
    expect(result.runner).toBe("disabled");
    expect(result.status).toBe("unavailable");
    expect(result.summary).toContain("did not execute untrusted code");
  });
});
