import type { RepositoryTestRun } from "@/types/conversation";
import type { RepositorySnapshot } from "@/types/iteration";

export interface RepositoryTestRequest {
  projectId: string;
  snapshot: RepositorySnapshot;
  commands: string[];
  explicitlyAuthorized: boolean;
}

export interface RepositoryTestRunner {
  readonly kind: RepositoryTestRun["runner"];
  readonly available: boolean;
  run(request: RepositoryTestRequest): Promise<RepositoryTestRun>;
}

const SAFE_SCRIPT_NAMES = ["test", "lint", "typecheck", "build"] as const;

export function discoverNodeTestCommands(evidenceText: string): string[] {
  const packageSection = evidenceText.match(/--- UNTRUSTED REPOSITORY DATA: package\.json ---\n([\s\S]*?)(?:\n--- UNTRUSTED REPOSITORY DATA:|$)/);
  if (!packageSection?.[1]) return [];
  try {
    const parsed = JSON.parse(packageSection[1]) as { scripts?: Record<string, unknown> };
    return SAFE_SCRIPT_NAMES.filter((name) => typeof parsed.scripts?.[name] === "string").map((name) => name === "test" ? "npm test" : `npm run ${name}`);
  } catch { return []; }
}

export class DisabledRepositoryTestRunner implements RepositoryTestRunner {
  readonly kind = "disabled" as const;
  readonly available = false;
  async run(request: RepositoryTestRequest): Promise<RepositoryTestRun> {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(), projectId: request.projectId,
      repositoryUrl: request.snapshot.repositoryUrl,
      commitSha: request.snapshot.commitSha ?? "unknown",
      commands: request.commands, runner: this.kind, status: "unavailable",
      summary: "Promgent inspected the repository and its test configuration, but did not execute untrusted code. No isolated runner is configured.",
      createdAt: now,
    };
  }
}

export const repositoryTestRunner: RepositoryTestRunner = new DisabledRepositoryTestRunner();
