// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { chat } from "@/lib/ai/chatClient";
import { implementationPromptArtifact } from "@/lib/artifacts/artifacts";
import { ArchitectureDiagram, parseArchitectureEdges } from "@/components/project/ArchitectureDiagram";
import { ArtifactCard } from "@/components/project/ArtifactCard";
import { AssistantMessageContent } from "@/components/project/AssistantMessageContent";
import { createInitialMemory, createProjectRecord } from "@/lib/projectMemory";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 720 320"><text>Application API</text><text>Database</text></svg>' })),
  },
}));

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

  it("renders Mermaid-style architecture edges as an accessible diagram", async () => {
    const source = "flowchart TD\nUSER[User] --> CLIENT[Next.js Web App]\nCLIENT --> API[Application API]\nAPI --> DB[(PostgreSQL)]";
    expect(parseArchitectureEdges(source)).toHaveLength(3);
    render(<ArchitectureDiagram source={source} />);
    expect(await screen.findByRole("img", { name: /architecture diagram showing/i })).toBeInTheDocument();
    expect(await screen.findByText("Application API")).toBeInTheDocument();
  });

  it("renders an inline architecture diagram inside a detailed assistant response", async () => {
    render(<AssistantMessageContent content={"## Architecture at a glance\nThe client calls trusted server logic.\n\n```mermaid\nflowchart TD\nUSER[User] --> CLIENT[Web app]\nCLIENT --> API[Application API]\nAPI --> DB[(Database)]\n```"} />);
    expect(screen.getByRole("heading", { name: "Architecture at a glance" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /architecture diagram showing/i })).toBeInTheDocument();
    expect(screen.queryByText("```mermaid")).not.toBeInTheDocument();
  });

  it("copies the complete compiled prompt rather than a preview", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const complete = `# Role\n${"Detailed project-specific instruction. ".repeat(200)}\n## Final Implementation Report`;
    render(<ArtifactCard artifact={{ id: "prompt", projectId: "project", type: "implementation_prompt", version: 2, title: "Implementation prompt", content: complete, structuredData: { promptDepth: "full_mvp", memoryVersion: 4 }, status: "current", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }} />);
    fireEvent.click(screen.getByRole("button", { name: /copy prompt/i }));
    expect(writeText).toHaveBeenCalledWith(complete);
  });
});
