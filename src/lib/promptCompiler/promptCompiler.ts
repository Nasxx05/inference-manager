import type {
  ClarifyingAnswer,
  ModelConfig,
  OptimizedScope,
  PlanResult,
  TaskAnalysis,
} from "@/types";
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
  /** Answers from the clarifying step. Skipped questions carry their default. */
  clarifyingAnswers?: ClarifyingAnswer[];
}

const BUILD_TASK_TYPES = new Set(["coding", "web-development"]);

/**
 * Question ids that only appear on tasks producing something buildable. A
 * task can classify as "general" and still be a build task (a bare
 * "build a tic-tac-toe game" has no coding keyword), so the questions are a
 * better signal than the task type alone.
 */
const BUILD_QUESTION_IDS = new Set([
  "game_mode",
  "game_platform",
  "game_rules",
  "platform",
  "api_style",
  "catalog",
  "auth_method",
  "storage_choice",
]);

function isBuildTask(analysis: TaskAnalysis, answers: ClarifyingAnswer[]): boolean {
  if (BUILD_TASK_TYPES.has(analysis.taskType)) return true;
  return (answers ?? []).some((a) => BUILD_QUESTION_IDS.has(a.id));
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

/** Keeps "Act as a experienced generalist" from appearing in the ROLE line. */
function articleFor(phrase: string): string {
  return /^[aeiou]/i.test(phrase.trim()) ? "an" : "a";
}

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

/** Questions the user answered explicitly. Treated as binding requirements. */
export function answeredRequirements(answers: ClarifyingAnswer[]): string[] {
  return (answers ?? [])
    .filter((a) => a.answered && a.answer.trim())
    .map((a) => `${a.question} -> ${a.answer.trim()}`);
}

/** Defaults applied because a question was skipped. Reversible assumptions. */
export function appliedDefaults(answers: ClarifyingAnswer[]): string[] {
  return (answers ?? [])
    .filter((a) => !a.answered && a.answer.trim())
    .map((a) => `${a.question} -> assumed: ${a.answer.trim()}`);
}

/**
 * Structure and architecture guidance for build tasks. Uses the answers when
 * they say something concrete, and falls back to generic but useful structure
 * guidance when they do not.
 */
function buildStructure(analysis: TaskAnalysis, answers: ClarifyingAnswer[]): string[] {
  const byId = new Map((answers ?? []).map((a) => [a.id, a.answer.trim()]));
  const lines: string[] = [];

  if (analysis.taskType === "web-development") {
    const sections = byId.get("sections");
    const stack = byId.get("stack");
    const features = byId.get("features");

    lines.push(
      "Organise the work as a small number of clearly separated components, one per section, " +
        "composed by a single page or layout that owns the overall order.",
    );
    if (sections) lines.push(`Follow this page and section order: ${sections}.`);
    if (stack) lines.push(`Build it on this stack: ${stack}.`);
    lines.push(
      "Keep content separate from presentation: hold text and data in plain structures, and let " +
        "components render from them rather than hardcoding content into markup.",
    );
    lines.push(
      "Keep styling consistent through shared tokens (colour, spacing, type scale) instead of " +
        "repeating raw values, so the result stays visually coherent throughout.",
    );
    if (features) {
      lines.push(`Support these behaviours, each isolated so it can be removed: ${features}.`);
    }
    lines.push(
      "Make it responsive from the start, and keep interactive state minimal and local to the " +
        "component that needs it.",
    );
    return lines;
  }

  const language = byId.get("language");
  const inputs = byId.get("inputs");
  const quality = byId.get("quality");
  const platform = byId.get("game_platform");

  lines.push(
    "Separate the work into a small number of well-named units with one responsibility each: " +
      "state or data, rules or logic, and presentation or output. Keep the boundaries explicit.",
  );
  const target = [language, platform].filter(Boolean).join("; ");
  if (target) lines.push(`Implement in: ${target}.`);
  if (inputs) lines.push(`Treat this as the input and output contract: ${inputs}.`);
  lines.push(
    "Put the core rules in one place that can be reasoned about and tested on its own, with " +
      "nothing else reaching into it directly.",
  );
  lines.push("Keep entry points thin: gather input, call the core, then render or return the result.");
  if (quality) lines.push(`Supporting work expected alongside the code: ${quality}.`);
  lines.push(
    "Name things after what they represent, and do not add layers, abstractions or " +
      "configurability that the current requirements do not call for.",
  );
  return lines;
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
    clarifyingAnswers = [],
  } = input;

  const role = ROLE_BY_TYPE[analysis.taskType] ?? ROLE_BY_TYPE.general;
  const scopeItems =
    scopeApplied && optimizedScope ? optimizedScope.included : extractScope(analysis, taskDescription);
  const outOfScope =
    scopeApplied && optimizedScope ? optimizedScope.deferred : ["Anything not listed under SCOPE"];

  const requirements = extractRequirements(analysis, taskDescription);
  const clarified = answeredRequirements(clarifyingAnswers);
  const defaults = appliedDefaults(clarifyingAnswers);

  const essential = (analysis.phases ?? [])
    .filter((p) => p.priority === "essential")
    .map((p) => `${p.name}: ${p.description}`);

  const sections: string[] = [];

  sections.push("ROLE");
  sections.push(`Act as ${articleFor(role)} ${role} working carefully and efficiently.`);

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
  if (clarified.length > 0) {
    sections.push("Confirmed by the requester, and binding:");
    sections.push(bullets(clarified, "Follow the confirmed requirements above."));
  }
  if (analysis.requiredCapabilities?.length) {
    sections.push(`Capabilities this work depends on: ${analysis.requiredCapabilities.join(", ")}.`);
  }

  if (defaults.length > 0) {
    sections.push("ASSUMED DEFAULTS");
    sections.push(
      "These were not specified, so the following reasonable defaults were assumed. " +
        "Satisfy them, and restate them briefly at the end so they can be corrected:",
    );
    sections.push(bullets(defaults, "No defaults were needed."));
  }

  if (isBuildTask(analysis, clarifyingAnswers)) {
    sections.push("STRUCTURE AND ARCHITECTURE");
    sections.push(
      "Build to this structure, aiming for the simplest structure that satisfies the requirements:",
    );
    sections.push(
      bullets(
        buildStructure(analysis, clarifyingAnswers),
        "Deliver the core objective completely.",
      ),
    );
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
      ...(defaults.length > 0
        ? ["- Every item under ASSUMED DEFAULTS is satisfied and listed for confirmation."]
        : []),
    ].join("\n"),
  );

  sections.push("OUTPUT FORMAT");
  sections.push(
    [
      "Return the finished work directly.",
      "Use clear structure with headings where it helps readability.",
      "Keep required explanations short and place them after the result.",
      'End with a short "Acceptance check" list confirming each SCOPE item is satisfied.',
      ...(defaults.length > 0
        ? ["- List the assumed defaults you applied, so the requester can correct them."]
        : []),
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

/** True when the prompt carries structure or architecture guidance. */
export function hasBuildStructure(prompt: string): boolean {
  return prompt.includes("STRUCTURE AND ARCHITECTURE");
}

export function planToHistoryName(plan: PlanResult): string {
  const summary = plan.analysis.summary?.trim();
  if (summary) return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
  const first = plan.taskDescription.trim().split("\n")[0];
  return first.length > 60 ? `${first.slice(0, 57)}...` : first || "Untitled task";
}