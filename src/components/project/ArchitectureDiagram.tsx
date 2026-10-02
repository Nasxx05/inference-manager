"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Maximize2, Minimize2, Minus, Plus } from "lucide-react";

export interface DiagramEdge {
  from: string;
  to: string;
}

const MIN_SCALE = 0.65;
const MAX_SCALE = 2;
const SCALE_STEP = 0.1;

function cleanLabel(value: string): string {
  return value.trim().replace(/^(["'])|(["'])$/g, "").replace(/<br\s*\/?>/gi, " / ").replace(/<[^>]+>/g, "").trim();
}

function nodeDefinitions(source: string): Map<string, string> {
  const labels = new Map<string, string>();
  const pattern = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[\(([^\]]+)\)\]|\[\[([^\]]+)\]\]|\[\{([^\]]+)\}\]|\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})/g;
  for (const match of source.matchAll(pattern)) {
    const label = cleanLabel(match.slice(2).find(Boolean) ?? match[1] ?? "");
    if (match[1] && label) labels.set(match[1], label);
  }
  return labels;
}

function endpoint(value: string, labels: Map<string, string>): string {
  const identifier = value.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*)/)?.[1];
  if (!identifier) return cleanLabel(value);
  return labels.get(identifier) ?? identifier.replaceAll("_", " ");
}

/** Parse the application-generated flowchart subset for accessibility/fallbacks. */
export function parseArchitectureEdges(source: string): DiagramEdge[] {
  const labels = nodeDefinitions(source);
  const edges: DiagramEdge[] = [];
  for (const line of source.split(/\r?\n/)) {
    const parts = line.trim().split(/\s*(?:-->|-\.->|==>|---)\s*/);
    if (parts.length < 2) continue;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const from = endpoint(parts[index] ?? "", labels);
      const to = endpoint(parts[index + 1] ?? "", labels);
      if (from && to) edges.push({ from, to });
    }
  }
  return edges;
}

export function sanitizeMermaidSource(source: string): string {
  const normalized = source.trim();
  if (!normalized || normalized.length > 50_000) throw new Error("Architecture source is empty or too large.");
  if (/%%\s*\{/i.test(normalized)) throw new Error("Mermaid configuration directives are not allowed.");
  if (/^\s*click\s+/im.test(normalized) || /javascript\s*:/i.test(normalized)) throw new Error("Interactive Mermaid links are not allowed.");
  if (/<\s*\/?\s*(?:script|iframe|object|embed|foreignObject|style|link|meta)\b/i.test(normalized) || /\bon\w+\s*=/i.test(normalized)) throw new Error("Unsafe HTML is not allowed in architecture diagrams.");
  return normalized;
}

export function buildArchitectureFallback(source: string): string {
  const edges = parseArchitectureEdges(source);
  if (!edges.length) return source.trim() || "No architecture connections are available.";
  const adjacency = new Map<string, string[]>();
  const targets = new Set<string>();
  for (const edge of edges) {
    const children = adjacency.get(edge.from) ?? [];
    if (!children.includes(edge.to)) children.push(edge.to);
    adjacency.set(edge.from, children);
    targets.add(edge.to);
  }
  const nodes = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  const roots = nodes.filter((node) => !targets.has(node));
  if (!roots.length) roots.push(nodes[0]!);
  const expanded = new Set<string>();
  const lines: string[] = [];
  const render = (node: string, prefix = "", branch = false, path = new Set<string>()) => {
    lines.push(`${prefix}${branch ? "+---> " : ""}[${node}]`);
    if (path.has(node)) {
      lines.push(`${prefix}      (cycle)`);
      return;
    }
    if (expanded.has(node)) {
      lines.push(`${prefix}      (shared connection)`);
      return;
    }
    expanded.add(node);
    const children = adjacency.get(node) ?? [];
    if (!children.length) return;
    const nextPath = new Set(path).add(node);
    lines.push(`${prefix}${branch ? "      " : ""}|`);
    children.forEach((child) => render(child, `${prefix}${branch ? "      " : ""}`, true, nextPath));
  };
  roots.forEach((root, index) => {
    if (index) lines.push("");
    render(root);
  });
  return lines.join("\n");
}

function architectureLabel(source: string): string {
  const nodes = [...new Set(parseArchitectureEdges(source).flatMap((edge) => [edge.from, edge.to]))];
  return nodes.length
    ? `Architecture diagram showing ${nodes.slice(0, 8).join(", ")}${nodes.length > 8 ? ` and ${nodes.length - 8} more components` : ""}.`
    : "System architecture diagram.";
}

export function ArchitectureDiagram({ source }: { source: string }) {
  const renderId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ width: 800, height: 450 });
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const label = architectureLabel(source);

  useEffect(() => {
    let active = true;
    setSvg("");
    setError(false);
    (async () => {
      try {
        const safeSource = sanitizeMermaidSource(source);
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          securityLevel: "strict",
          theme: "base",
          flowchart: { htmlLabels: false, useMaxWidth: false, curve: "linear", nodeSpacing: 35, rankSpacing: 50, wrappingWidth: 220 },
          themeVariables: {
            fontFamily: "IBM Plex Sans, sans-serif",
            fontSize: "14px",
            primaryColor: "#ffffff",
            primaryTextColor: "#20241f",
            primaryBorderColor: "#cfd3cc",
            lineColor: "#7c8178",
            secondaryColor: "#f6f7f4",
            tertiaryColor: "#f6f7f4",
          },
        });
        const rendered = await mermaid.render(`architecture-${renderId}`, safeSource);
        if (active) setSvg(rendered.svg);
      } catch (renderError) {
        if (process.env.NODE_ENV === "development") console.warn("[architecture-diagram] Mermaid render failed", renderError instanceof Error ? renderError.message : "Unknown rendering error");
        if (active) setError(true);
      }
    })();
    return () => { active = false; };
  }, [renderId, source]);

  const fit = useCallback(() => {
    const availableWidth = Math.max(1, (viewportRef.current?.clientWidth ?? naturalSize.width) - 24);
    setScale(Math.max(MIN_SCALE, Math.min(1, availableWidth / naturalSize.width)));
  }, [naturalSize.width]);

  useEffect(() => {
    if (!svg || !canvasRef.current) return;
    const element = canvasRef.current.querySelector("svg");
    if (!element) return;
    const viewBox = element.viewBox.baseVal;
    const width = viewBox?.width || Number(element.getAttribute("width")) || 800;
    const height = viewBox?.height || Number(element.getAttribute("height")) || 450;
    setNaturalSize({ width, height });
  }, [svg]);

  useEffect(() => {
    if (!fitMode) return;
    fit();
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded, fit, fitMode, naturalSize.width, svg]);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", close);
    };
  }, [expanded]);

  const zoom = (amount: number) => {
    setFitMode(false);
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((current + amount) * 10) / 10)));
  };
  const showFit = () => { setFitMode(true); requestAnimationFrame(fit); };
  const showActual = () => { setFitMode(false); setScale(1); };

  return (
    <div className={expanded ? "fixed inset-0 z-50 bg-ink/50 p-2 sm:p-6" : "max-w-full"}>
      <section className={`flex max-w-full flex-col overflow-hidden rounded-lg border border-line bg-paper ${expanded ? "h-full shadow-2xl" : ""}`} aria-label="Architecture diagram viewer">
        <div className="flex flex-wrap items-center justify-end gap-1 border-b border-line bg-canvas px-2 py-2">
          <button type="button" onClick={showFit} aria-pressed={fitMode} className="rounded px-2 py-1 text-xs text-muted hover:bg-paper hover:text-ink">Fit</button>
          <button type="button" onClick={() => zoom(-SCALE_STEP)} aria-label="Zoom out" className="rounded p-1.5 text-muted hover:bg-paper hover:text-ink"><Minus className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={showActual} aria-label="Reset zoom to 100%" className="min-w-12 rounded px-2 py-1 font-mono text-[11px] text-muted hover:bg-paper hover:text-ink">{Math.round(scale * 100)}%</button>
          <button type="button" onClick={() => zoom(SCALE_STEP)} aria-label="Zoom in" className="rounded p-1.5 text-muted hover:bg-paper hover:text-ink"><Plus className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "Close expanded diagram" : "Expand diagram"} className="ml-1 inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted hover:bg-paper hover:text-ink">
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}{expanded ? "Close" : "Expand"}
          </button>
        </div>
        <div ref={viewportRef} className={`max-w-full overflow-auto bg-canvas p-3 ${expanded ? "min-h-0 flex-1" : "max-h-[36rem]"}`}>
          {error ? <div role="img" aria-label={label} className="min-w-max rounded border border-line bg-paper p-4">
            <p className="mb-3 text-sm text-danger">The visual diagram could not be rendered.</p>
            <pre className="whitespace-pre font-mono text-xs leading-6 text-ink">{buildArchitectureFallback(source)}</pre>
          </div> : svg ? <div
            ref={canvasRef}
            role="img"
            aria-label={label}
            className="origin-top-left [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_.nodeLabel]:text-ink"
            style={{ width: naturalSize.width * scale, height: naturalSize.height * scale }}
            dangerouslySetInnerHTML={{ __html: svg }}
          /> : <div role="status" className="grid min-h-40 place-items-center text-sm text-muted">Rendering architecture…</div>}
        </div>
      </section>
    </div>
  );
}
