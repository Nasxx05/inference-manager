/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ArchitectureDiagram,
  buildArchitectureFallback,
  parseArchitectureEdges,
  sanitizeMermaidSource,
} from "@/components/project/ArchitectureDiagram";

const renderMermaid = vi.fn(async (_id: string, source: string) => ({
  svg: `<svg viewBox="0 0 1200 700"><text>${source.includes("Next.js Server Actions and API Routes") ? "Next.js Server Actions and API Routes" : "Architecture"}</text></svg>`,
}));

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMermaid },
}));

const branching = `flowchart TD
  User --> WebApp
  WebApp --> API
  API --> Auth
  API --> Database
  API --> Email
  Database --> Reservations
  Database --> Menu`;

describe("ArchitectureDiagram", () => {
  it("preserves long labels and branching relationships", () => {
    const source = `${branching}\n  API --> SERVER[Next.js Server Actions and API Routes]`;
    const edges = parseArchitectureEdges(source);
    expect(edges).toContainEqual({ from: "API", to: "Next.js Server Actions and API Routes" });
    expect(edges.filter((edge) => edge.from === "API")).toHaveLength(4);
    expect(edges.some((edge) => edge.to.includes("..."))).toBe(false);
  });

  it("builds a deterministic text fallback from the same graph", () => {
    const fallback = buildArchitectureFallback(branching);
    expect(fallback).toContain("[User]");
    expect(fallback).toContain("+---> [Auth]");
    expect(fallback).toContain("+---> [Database]");
    expect(fallback).toContain("+---> [Email]");
  });

  it("rejects directives, scripts, and interactive links", () => {
    expect(() => sanitizeMermaidSource("%%{init: {'securityLevel': 'loose'}}%%\nflowchart TD\nA --> B")).toThrow(/directives/i);
    expect(() => sanitizeMermaidSource("flowchart TD\nA[<script>alert(1)</script>] --> B")).toThrow(/unsafe html/i);
    expect(() => sanitizeMermaidSource("flowchart TD\nA --> B\nclick A javascript:alert(1)")).toThrow(/links/i);
  });

  it("renders controls, zooms, expands, and closes expanded view with Escape", async () => {
    render(<ArchitectureDiagram source={`${branching}\nAPI --> SERVER[Next.js Server Actions and API Routes]`} />);
    expect(await screen.findByRole("img", { name: /architecture diagram showing/i })).toBeInTheDocument();
    expect(screen.getByText("Next.js Server Actions and API Routes")).toBeInTheDocument();
    const zoomLabel = screen.getByRole("button", { name: "Reset zoom to 100%" });
    const beforeZoom = Number(zoomLabel.textContent?.replace("%", ""));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(Number(zoomLabel.textContent?.replace("%", ""))).toBeGreaterThan(beforeZoom);
    fireEvent.click(screen.getByRole("button", { name: "Expand diagram" }));
    expect(screen.getByRole("button", { name: "Close expanded diagram" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand diagram" })).toBeInTheDocument());
  });

  it("falls back without crashing when Mermaid input is invalid or unsafe", async () => {
    render(<ArchitectureDiagram source={`%%{init: {'securityLevel': 'loose'}}%%\n${branching}`} />);
    expect(await screen.findByText("The visual diagram could not be rendered.")).toBeInTheDocument();
    expect(screen.getByText(/\[User\]/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /architecture diagram showing/i })).toBeInTheDocument();
  });

  it("keeps a 15-node, 20-edge graph inside a dedicated scroll viewport", async () => {
    const edges = Array.from({ length: 20 }, (_, index) => `N${index % 15}[Node ${index % 15}] --> N${(index + 1) % 15}[Node ${(index + 1) % 15}]`);
    const { container } = render(<ArchitectureDiagram source={`flowchart LR\n${edges.join("\n")}`} />);
    expect(parseArchitectureEdges(edges.join("\n"))).toHaveLength(20);
    await screen.findByRole("img", { name: /architecture diagram showing/i });
    expect(container.querySelector(".overflow-auto")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("max-w-full");
  });
});
