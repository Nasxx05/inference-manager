import type { ReactNode } from "react";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

function inline(value: string): ReactNode {
  const parts = value.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => part.startsWith("**") && part.endsWith("**")
    ? <strong key={`${part}-${index}`} className="font-semibold text-ink">{part.slice(2, -2)}</strong>
    : part);
}

/** Small safe renderer for the plain Markdown subset Promgent writes. */
export function AssistantMessageContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: Array<{ type: "line" | "mermaid" | "code"; content: string; key: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("```")) {
      blocks.push({ type: "line", content: line, key: index });
      continue;
    }
    const mermaid = line.trim().toLowerCase() === "```mermaid";
    const collected: string[] = [];
    const start = index;
    for (index += 1; index < lines.length && lines[index]?.trim() !== "```"; index += 1) collected.push(lines[index] ?? "");
    blocks.push({ type: mermaid ? "mermaid" : "code", content: collected.join("\n"), key: start });
  }
  return (
    <div className="space-y-2 text-sm leading-7">
      {blocks.map((block) => {
        if (block.type === "mermaid") return <ArchitectureDiagram key={block.key} source={block.content} />;
        if (block.type === "code") return <pre key={block.key} className="overflow-auto rounded-lg bg-canvas p-4 font-mono text-xs leading-6 text-ink">{block.content}</pre>;
        const line = block.content.trim();
        if (!line) return <div key={`space-${block.key}`} className="h-1" aria-hidden="true" />;
        if (line.startsWith("# ")) return <h2 key={block.key} className="pt-3 text-lg font-semibold tracking-tight text-ink">{inline(line.slice(2))}</h2>;
        if (line.startsWith("## ")) return <h3 key={block.key} className="pt-3 text-base font-semibold tracking-tight text-ink">{inline(line.slice(3))}</h3>;
        if (line.startsWith("### ")) return <h4 key={block.key} className="pt-2 text-sm font-semibold tracking-tight text-forest">{inline(line.slice(4))}</h4>;
        if (/^[-*]\s+/.test(line)) return <div key={block.key} className="grid grid-cols-[12px_1fr] gap-2 text-muted"><span className="pt-px text-forest">•</span><span>{inline(line.replace(/^[-*]\s+/, ""))}</span></div>;
        if (/^\d+\.\s+/.test(line)) return <div key={block.key} className="pl-1 text-muted">{inline(line)}</div>;
        return <p key={block.key} className="text-ink/90">{inline(line)}</p>;
      })}
    </div>
  );
}
