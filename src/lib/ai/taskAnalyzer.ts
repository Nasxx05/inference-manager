import type { Complexity, TaskAnalysis, TaskPhase, TaskType } from "@/types";

const TYPE_KEYWORDS: Array<{ type: TaskType; keywords: string[] }> = [
  {
    type: "web-development",
    keywords: ["website", "web app", "webapp", "landing page", "next.js", "nextjs", "react", "tailwind", "frontend", "portfolio", "responsive", "component"],
  },
  {
    type: "coding",
    keywords: ["api", "backend", "function", "refactor", "bug", "script", "cli", "database", "server", "typescript", "python", "code", "implement", "library", "sdk"],
  },
  {
    type: "research",
    keywords: ["research", "compare", "market", "competitor", "investigate", "find out", "sources", "citations", "study", "landscape"],
  },
  {
    type: "writing",
    keywords: ["write", "draft", "blog", "article", "copy", "essay", "email", "newsletter", "rewrite", "edit"],
  },
  {
    type: "document-analysis",
    keywords: ["document", "review this", "summarize this", "contract", "pdf", "extract from", "analyze the file"],
  },
  {
    type: "data-analysis",
    keywords: ["data", "dataset", "csv", "metrics", "chart", "forecast", "sql", "statistics", "cohort"],
  },
  {
    type: "planning",
    keywords: ["plan", "roadmap", "strategy", "outline a plan", "schedule", "organize", "milestones"],
  },
  {
    type: "creative",
    keywords: ["design", "brand", "logo", "story", "creative", "concept", "campaign", "illustration"],
  },
];

function classify(text: string): TaskType {
  const lower = text.toLowerCase();
  let best: { type: TaskType; score: number } = { type: "general", score: 0 };
  for (const entry of TYPE_KEYWORDS) {
    const score = entry.keywords.reduce((acc, k) => (lower.includes(k) ? acc + 1 : acc), 0);
    if (score > best.score) best = { type: entry.type, score };
  }
  return best.type;
}

export function scoreComplexity(text: string): Complexity {
  const lower = text.toLowerCase();
  let score = 0;

  const words = text.trim().split(/\s+/).length;
  if (words > 60) score += 3;
  else if (words > 30) score += 2;
  else if (words > 12) score += 1;

  // Heavy subsystems cost far more than surface features, so weight them higher.
  const heavyFeatures = ["auth", "payment", "checkout", "admin", "dashboard", "database", "real-time", "websocket", "integration", "deploy", "microservice"];
  const lightFeatures = ["responsive", "dark mode", "animation", "search", "test", "analytics", "api", "form", "navigation", "section", "page", "component", "mobile"];

  score += heavyFeatures.reduce((acc, m) => (lower.includes(m) ? acc + 2 : acc), 0);
  score += lightFeatures.reduce((acc, m) => (lower.includes(m) ? acc + 1 : acc), 0);

  if (/full|complete|entire|end-to-end|production-ready|platform|system/.test(lower)) score += 3;
  if (/simple|quick|small|basic/.test(lower)) score -= 2;

  if (score <= 3) return "low";
  if (score <= 8) return "medium";
  if (score <= 14) return "high";
  return "very-high";
}

const COMPLEXITY_PROFILE: Record<Complexity, { input: number; output: number; iterations: number }> = {
  low: { input: 40000, output: 25000, iterations: 2 },
  medium: { input: 200000, output: 150000, iterations: 3 },
  high: { input: 550000, output: 400000, iterations: 4 },
  "very-high": { input: 1100000, output: 800000, iterations: 5 },
};

function phasesFor(type: TaskType, complexity: Complexity): TaskPhase[] {
  const heavy = complexity === "high" || complexity === "very-high";
  switch (type) {
    case "research":
      return [
        { name: "Question framing", description: "Define the precise questions and success criteria", priority: "essential", costWeight: 0.1, estimatedCost: [0, 0] },
        { name: "Research", description: "Gather and review relevant sources", priority: "essential", costWeight: 0.4, estimatedCost: [0, 0] },
        { name: "Source validation", description: "Cross-check claims and note confidence", priority: "recommended", costWeight: 0.2, estimatedCost: [0, 0] },
        { name: "Synthesis", description: "Combine findings into a coherent answer", priority: "essential", costWeight: 0.2, estimatedCost: [0, 0] },
        { name: "Final response", description: "Deliver the structured result", priority: "essential", costWeight: 0.1, estimatedCost: [0, 0] },
      ];
    case "writing":
      return [
        { name: "Outline", description: "Plan structure and key points", priority: "essential", costWeight: 0.15, estimatedCost: [0, 0] },
        { name: "Draft", description: "Produce the first full draft", priority: "essential", costWeight: 0.45, estimatedCost: [0, 0] },
        { name: "Revision", description: "Tighten clarity, tone and structure", priority: "recommended", costWeight: 0.25, estimatedCost: [0, 0] },
        { name: "Final polish", description: "Copy-edit and confirm against requirements", priority: "essential", costWeight: 0.15, estimatedCost: [0, 0] },
      ];
    case "coding":
    case "web-development":
      return [
        { name: "Requirements", description: "Confirm scope, constraints and acceptance criteria", priority: "essential", costWeight: 0.1, estimatedCost: [0, 0] },
        { name: "Architecture", description: "Decide structure, files and key decisions", priority: "essential", costWeight: 0.12, estimatedCost: [0, 0] },
        { name: "Implementation", description: "Build the core functionality", priority: "essential", costWeight: 0.45, estimatedCost: [0, 0] },
        { name: "Testing", description: "Verify behaviour against acceptance criteria", priority: heavy ? "essential" : "recommended", costWeight: 0.2, estimatedCost: [0, 0] },
        { name: "Final review", description: "Clean up, confirm completeness, summarize", priority: "recommended", costWeight: 0.13, estimatedCost: [0, 0] },
      ];
    default:
      return [
        { name: "Requirements", description: "Clarify the objective and constraints", priority: "essential", costWeight: 0.15, estimatedCost: [0, 0] },
        { name: "Execution", description: "Produce the core deliverable", priority: "essential", costWeight: 0.55, estimatedCost: [0, 0] },
        { name: "Review", description: "Validate against the requirements and finalize", priority: "recommended", costWeight: 0.3, estimatedCost: [0, 0] },
      ];
  }
}

function risksFor(text: string, complexity: Complexity): string[] {
  const risks: string[] = [];
  const lower = text.toLowerCase();
  if (lower.includes("auth")) risks.push("Authentication flows often expand scope");
  if (lower.includes("payment")) risks.push("Payment handling adds compliance and testing overhead");
  if (lower.includes("real-time") || lower.includes("websocket")) risks.push("Real-time behaviour increases iteration count");
  if (complexity === "high" || complexity === "very-high") risks.push("High complexity raises the chance of extra revision passes");
  if (risks.length === 0) risks.push("Ambiguous requirements can cause rework");
  return risks;
}

function toolsFor(type: TaskType): string[] {
  switch (type) {
    case "research":
      return ["web search", "source citation"];
    case "coding":
    case "web-development":
      return ["file editing", "terminal commands", "test runner"];
    case "data-analysis":
      return ["data inspection", "charting"];
    default:
      return [];
  }
}

function capabilitiesFor(type: TaskType): string[] {
  switch (type) {
    case "coding":
    case "web-development":
      return ["code generation", "architectural reasoning"];
    case "research":
      return ["source evaluation", "synthesis"];
    case "data-analysis":
      return ["quantitative reasoning"];
    case "writing":
      return ["structured writing", "tone control"];
    default:
      return ["instruction following", "structured output"];
  }
}

/**
 * Build a readable objective. Truncate on a sentence or clause boundary so the
 * OBJECTIVE section never ends mid-phrase.
 */
function buildSummary(taskDescription: string): string {
  const cleaned = taskDescription.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 200) return cleaned;

  const cut = cleaned.slice(0, 200);
  const boundary = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf(", "),
    cut.lastIndexOf("; "),
    cut.lastIndexOf(" "),
  );
  return `${cut.slice(0, boundary > 80 ? boundary : 200).trimEnd()}...`;
}

export function heuristicAnalyze(taskDescription: string): TaskAnalysis {
  const taskType = classify(taskDescription);
  const complexity = scoreComplexity(taskDescription);
  const profile = COMPLEXITY_PROFILE[complexity];

  return {
    taskType,
    summary: buildSummary(taskDescription),
    complexity,
    requiredCapabilities: capabilitiesFor(taskType),
    estimatedInputTokens: profile.input,
    estimatedOutputTokens: profile.output,
    expectedIterations: profile.iterations,
    toolRequirements: toolsFor(taskType),
    phases: phasesFor(taskType, complexity),
    risks: risksFor(taskDescription, complexity),
    scopeAdjustments: [
      "Ship the core path first, then layer optional enhancements.",
      "Keep explanations short and place them after the deliverable.",
    ],
  };
}