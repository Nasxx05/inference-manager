"use client";

import { Check, Copy, FileText } from "lucide-react";
import { useState } from "react";
import type { ProjectArtifact } from "@/types/conversation";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

export function ArtifactCard({ artifact }: { artifact: ProjectArtifact }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  const diagramSource = artifact.type === "architecture" && typeof artifact.structuredData.diagramSource === "string"
    ? artifact.structuredData.diagramSource
    : null;
  const architectureSummary = diagramSource ? artifact.content.split("```mermaid")[0]?.trim() : null;

  return (
    <details className="group mt-4 overflow-hidden rounded-lg border border-line bg-paper">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-canvas">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-forest-light text-forest">
            <FileText className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{artifact.title}</span>
            <span className="font-mono text-[11px] uppercase tracking-wide text-muted">
              {artifact.type.replaceAll("_", " ")} · v{artifact.version}
            </span>
          </span>
        </span>
        <span className="text-xs text-muted group-open:hidden">Open</span>
        <span className="hidden text-xs text-muted group-open:inline">Close</span>
      </summary>
      <div className="border-t border-line px-4 py-4">
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {diagramSource ? <div className="space-y-4">
          {architectureSummary ? <p className="text-sm leading-6 text-muted">{architectureSummary}</p> : null}
          <ArchitectureDiagram source={diagramSource} />
          <details className="text-xs text-muted"><summary className="cursor-pointer">View diagram source</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-3 font-mono leading-6 text-ink">{diagramSource}</pre></details>
        </div> : <div className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-mono text-xs leading-6 text-ink">{artifact.content}</div>}
      </div>
    </details>
  );
}
