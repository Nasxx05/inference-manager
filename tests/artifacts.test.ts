import { describe, expect, it } from "vitest";
import { artifactEquivalent, buildArtifact, projectBlueprint } from "@/lib/artifacts/artifacts";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory/intake";

const now = "2026-09-30T00:00:00.000Z";
const project = createProjectRecord({ id: "project", userId: "user", description: "A restaurant booking website", modelId: "auto", planningDepth: "balanced", budget: 8, now });

describe("artifact versioning", () => {
  it("reuses an unchanged current version", () => {
    const first = buildArtifact({ id: "one", projectId: "project", type: "architecture", title: "Architecture", content: "same", structuredData: { b: 2, a: 1 }, now });
    expect(buildArtifact({ id: "two", projectId: "project", type: "architecture", title: "Architecture", content: "same", structuredData: { a: 1, b: 2 }, previous: first, now })).toBe(first);
    expect(artifactEquivalent(first, { content: "same", structuredData: { a: 1, b: 2 } })).toBe(true);
  });

  it("supersedes a changed version", () => {
    const first = buildArtifact({ id: "one", projectId: "project", type: "project_blueprint", title: "Blueprint", content: "v1", now });
    const second = buildArtifact({ id: "two", projectId: "project", type: "project_blueprint", title: "Blueprint", content: "v2", previous: first, now });
    expect(second.version).toBe(2);
    expect(second.supersedesArtifactId).toBe("one");
  });

  it("builds a beginner-readable blueprint from canonical memory", () => {
    const blueprint = projectBlueprint(createInitialMemory(project, now));
    expect(blueprint.content).toContain("What we are building");
    expect(blueprint.content).toContain("Core first-version features");
    expect(blueprint.content).not.toContain("RTM");
  });
});
