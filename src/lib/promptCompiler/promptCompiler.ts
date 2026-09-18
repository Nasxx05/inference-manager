import type { ModelConfig, OptimizedScope, PlanResult, TaskAnalysis } from "@/types";
import { formatCredit } from "@/lib/estimator/costEstimator";

export interface CompileInput {
  taskDescription: string;
  analysis: TaskAnalysis;
  model: ModelConfig;
  budget: number;
  optimization: string;
  scopeApplied: boolean;
  optimizedScope: OptimizedScope | null;
  costRange: { minimum: number; maximum: number; recommendedMaximum: number };
}

const ROLE_BY_TYPE: Record<string, string> = {
  coding: "senior software engineer",
  "web-development": "senior frontend engineer",
  research: "rigorous research analyst",
  writing: "professional editor and writer",
  "document-analysis": "analytical document reviewer",
  "data-analysis": "data analyst",
  planning: "structured project planner",
  creative: "creative director",
  general: "experienced generalist problem solver",
};

/**
 * Split the user's own wording into concrete requirement lines where possible,
 * so REQUIREMENTS reflects the request rather than internal phase names.
 */
function splitUserRequirements(taskDescription: string): string[] {
  const text = taskDescription.trim().replace(/\s+/g, " ");
  if (!text) return [];

  // Don't split on periods inside known tokens such as "Next.js" or "Node.js".
  const protectedText = text.replace(/\b(next|node|vue|nuxt)\.js\b/gi, "$1DOTjs");

  const clauses = protectedText
    .split(/[,.;]|\band\b|\bwith\b|\bincluding\b|\binclude\b/gi)
    .map((c) => c.trim())
    .filter((c) => c.length > 3)
    .map((c) => c.replace(/DOTjs/gi, ".js"));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const clause of clauses) {
    const key = clause.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clause.charAt(0).toUpperCase() + clause.slice(1));
  }
  return out;
}

function extractRequirements(analysis: TaskAnalysis, taskDescription: string): string[] {
  const fromUser = splitUserRequirements(taskDescription);
  if (fromUser.length > 0) return fromUser;
  return (analysis.phases ?? [])
    .filter((p) => p.description)
    .map((p) => `${p.name}: ${p.description}`);
}

function extractScope(analysis: TaskAnalysis, taskDescription: string): string[] {
  const out = (analysis.phases ?? [])
    .filter((p) => p.priority === "essential")
    .map((p) => `${p.name} - ${p.description}`);
  if (out.length > 0) return out;
  const fromUser = splitUserRequirements(taskDescription);
  return fromUser.length > 0 ? fromUser : [taskDescription.trim()];
}

function bullets(items: string[], fallback: string): string {
  const clean = (items ?? []).map((i) => String(i).trim()).filter(Boolean);
  if (clean.length === 0) return `- ${fallback}`;
  return clean.map((i) => `- ${i}`).join("\n");
}

export function compilePrompt(input: CompileInput): string {
  const {
    taskDescription,
    analysis,
    model,
    budget,
    optimization,
    scopeApplied,
    optimizedScope,
    costRange,
  } = input;

  const role = ROLE_BY_TYPE[analysis.taskType] ?? ROLE_BY_TYPE.general;
  const scopeItems =
    scopeApplied && optimizedScope ? optimizedScope.included : extractScope(analysis, taskDescription);
  const outOfScope =
    scopeApplied && optimizedScope ? optimizedScope.deferred : ["Anything not listed under SCOPE"];

  const requirements = extractRequirements(analysis, taskDescription);

  const essential = (analysis.phases ?? [])
    .filter((p) => p.priority === "essential")
    .map((p) => `${p.name}: ${p.description}`);

  const sections: string[] = [];

  sections.push("ROLE");
  sections.push(`Act as a ${role} working carefully and efficiently.`);

  sections.push("OBJECTIVE");
  sections.push(analysis.summary || taskDescription.trim());

  sections.push("CONTEXT");
  sections.push(taskDescription.trim());
  sections.push(
    `Task type: ${analysis.taskType}. Complexity: ${analysis.complexity}. ` +
      `Target execution model: ${model.displayName} (${model.provider}).`,
  );

  sections.push("REQUIREMENTS");
  sections.push(bullets(requirements, "Satisfy the objective described above."));
  if (analysis.requiredCapabilities?.length) {
    sections.push(`Capabilities this work depends on: ${analysis.requiredCapabilities.join(", ")}.`);
  }

  sections.push("SCOPE");
  sections.push(bullets(scopeItems, "Deliver the core objective completely."));

  sections.push("OUT OF SCOPE");
  sections.push(bullets(outOfScope, "Do not add features beyond the requested objective."));

  sections.push("PRIORITIES");
  sections.push(
    bullets(essential, "Correctness and completeness of the core objective come first; polish comes last."),
  );

  sections.push("EXECUTION STRATEGY");
  sections.push(
    bullets(
      (analysis.phases ?? []).map((p, i) => `${i + 1}. ${p.name} - ${p.description}`),
      "Work through the objective in ordered steps, finishing each before moving on.",
    ),
  );
  if (analysis.toolRequirements?.length) {
    sections.push(`Tooling allowed where relevant: ${analysis.toolRequirements.join(", ")}.`);
  }

  sections.push("CONSTRAINTS");
  sections.push(
    [
      "- Keep the output focused on the stated objective.",
      "- Do not add unrequested features, abstractions, or explanations.",
      "- Prefer the smallest complete solution over the most elaborate one.",
      "- Work within the budget described below and avoid redundant rewrites.",
      `- Optimization preference: ${optimization}.`,
      `- Expected iterations: ${analysis.expectedIterations || 1}.`,
    ].join("\n"),
  );

  sections.push("BUDGET CONSTRAINT");
  sections.push(
    `The available inference budget for this task is approximately ${formatCredit(budget)} CREDIT ` +
      `(planning estimate ${formatCredit(costRange.minimum)} - ${formatCredit(costRange.maximum)} CREDIT, ` +
      `recommended maximum ${formatCredit(costRange.recommendedMaximum)} CREDIT).`,
  );
  sections.push(
    `Prioritize the highest-value requirements first. Avoid unnecessary explanations, redundant ` +
      `rewrites, unrequested features, excessive abstractions, and non-essential output. Complete the ` +
      `core requirements before optional improvements. Use targeted corrections rather than restarting ` +
      `the entire task. Stop once the required acceptance criteria are satisfied.`,
  );

  sections.push("VALIDATION");
  sections.push(
    bullets(
      [
        "Check the result against every item under REQUIREMENTS before finishing.",
        "Verify the output is complete, internally consistent, and runnable or usable as requested.",
        ...(analysis.risks ?? []).map((r) => `Pay attention to: ${r}.`),
      ],
      "Re-read the result against the requirements and fix gaps before returning it.",
    ),
  );

  sections.push("REVISION POLICY");
  sections.push(
    `Prefer targeted corrections over full rewrites. Fix only what fails validation, and do not ` +
      `regenerate correct work. Stop revising once acceptance criteria pass.`,
  );

  sections.push("STOPPING CONDITIONS");
  sections.push(
    [
      "- All items under SCOPE are complete.",
      "- Validation passes with no unresolved gaps.",
      "- No further change would meaningfully improve the result.",
    ].join("\n"),
  );

  sections.push("OUTPUT FORMAT");
  sections.push(
    [
      "Return the finished work directly.",
      "Use clear structure with headings where it helps readability.",
      "Keep required explanations short and place them after the result.",
      'End with a short "Acceptance check" list confirming each SCOPE item is satisfied.',
    ]
      .map((l) => `- ${l}`)
      .join("\n"),
  );

  return `${sections.join("\n\n").trim()}\n`;
}

export function requiredSectionsPresent(prompt: string): boolean {
  const required = [
    "ROLE",
    "OBJECTIVE",
    "CONTEXT",
    "REQUIREMENTS",
    "SCOPE",
    "OUT OF SCOPE",
    "PRIORITIES",
    "EXECUTION STRATEGY",
    "CONSTRAINTS",
    "BUDGET CONSTRAINT",
    "VALIDATION",
    "REVISION POLICY",
    "STOPPING CONDITIONS",
    "OUTPUT FORMAT",
  ];
  return required.every((section) => prompt.includes(section));
}

export function planToHistoryName(plan: PlanResult): string {
  const summary = plan.analysis.summary?.trim();
  if (summary) return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
  const first = plan.taskDescription.trim().split("\n")[0];
  return first.length > 60 ? `${first.slice(0, 57)}...` : first || "Untitled task";
}