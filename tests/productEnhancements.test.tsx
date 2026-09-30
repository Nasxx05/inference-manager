// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { chat } from "@/lib/ai/chatClient";
import { implementationPromptArtifact } from "@/lib/artifacts/artifacts";
import { ArchitectureDiagram, parseArchitectureEdges } from "@/components/project/ArchitectureDiagram";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";

afterEach(() => vi.unstubAllGlobals());

describe("conversation product enhancements", () => {
  it("keeps the provider's exact charge for the project usage ledger", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      model: "z-ai/glm-test",
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00425 },
    })));
    const result = await chat({
      apiKey: "test-key",
      baseUrl: "https://provider.example/v1",
      model: "z-ai/glm-test",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 20,
      stage: "project-conversation",
      retry: false,
    });
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cost: 0.00425 });
  });

  it("builds a detailed implementation prompt from canonical project memory", () => {
    const project = createProjectRecord({
      id: "project_prompt",
      userId: "user_prompt",
      description: "A booking application for independent barbers",
      modelId: "auto",
      planningDepth: "balanced",
      budget: 10,
      now: "2026-01-01T00:00:00.000Z",
    });
    const memory = createInitialMemory(project);
    const artifact = implementationPromptArtifact({
      memory,
      additionalInstructions: "Keep the booking form usable on mobile.",
    });
    expect(artifact.content).toContain("## Required scope");
    expect(artifact.content).toContain("## Acceptance criteria");
    expect(artifact.content).toContain("## Verification");
    expect(artifact.content).toContain("## Final report");
    expect(artifact.content).toContain("Keep the booking form usable on mobile.");
  });

  it("renders Mermaid-style architecture edges as an accessible skeleton diagram", () => {
    const source = "flowchart TD\nUser --> Client\nClient --> Application API\nApplication API --> Database";
    expect(parseArchitectureEdges(source)).toHaveLength(3);
    render(<ArchitectureDiagram source={source} />);
    expect(screen.getByRole("img", { name: /system architecture skeleton diagram/i })).toBeInTheDocument();
    expect(screen.getByText("Application API")).toBeInTheDocument();
  });
});
