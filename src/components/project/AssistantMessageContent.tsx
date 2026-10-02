import type { ReactNode } from "react";

function inline(value: string): ReactNode {
  const parts = value.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => part.startsWith("**") && part.endsWith("**")
    ? <strong key={`${part}-${index}`} className="font-semibold text-ink">{part.slice(2, -2)}</strong>
    : part);
}

/** Small safe renderer for the plain Markdown subset Promgent writes. */
export function AssistantMessageContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  return (
    <div className="space-y-2 text-sm leading-7">
      {lines.map((raw, index) => {
        const line = raw.trim();
        if (!line) return <div key={`space-${index}`} className="h-1" aria-hidden="true" />;
        if (line.startsWith("## ")) return <h3 key={index} className="pt-2 text-base font-semibold tracking-tight text-ink">{inline(line.slice(3))}</h3>;
        if (line.startsWith("### ")) return <h4 key={index} className="pt-1 text-xs font-semibold uppercase tracking-[0.1em] text-forest">{inline(line.slice(4))}</h4>;
        if (/^[-*]\s+/.test(line)) return <div key={index} className="grid grid-cols-[12px_1fr] gap-2 text-muted"><span className="pt-px text-forest">•</span><span>{inline(line.replace(/^[-*]\s+/, ""))}</span></div>;
        if (/^\d+\.\s+/.test(line)) return <div key={index} className="pl-1 text-muted">{inline(line)}</div>;
        return <p key={index} className="text-ink/90">{inline(line)}</p>;
      })}
    </div>
  );
}
