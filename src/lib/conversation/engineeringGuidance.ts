import { buildTechnicalBlueprint } from "@/lib/technicalBlueprint";
import type { ConversationIntent, EngineeringGuidance, PromgentResponseProposal } from "@/types/conversation";
import type { ProjectMemory } from "@/types/project";
import type { TechnicalBlueprint } from "@/types/technicalBlueprint";

const SUBSTANTIAL_INTENTS = new Set<ConversationIntent>([
  "project_discovery",
  "requirement_change",
  "change_request",
  "architecture_request",
  "architecture_discussion",
  "build_plan_request",
  "prompt_generation",
  "next_step_request",
]);

const DIAGRAM_INTENTS = new Set<ConversationIntent>([
  "project_discovery",
  "architecture_request",
  "architecture_discussion",
  "build_plan_request",
]);

function unique(values: Array<string | undefined>, limit: number): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, limit);
}

function prose(value: string): string {
  return value
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^(?:#{1,6}|[-*]|\d+\.)\s+/, ""))
    .filter(Boolean)
    .join(" ");
}

function ensureDetailed(value: string, supplement: string): string {
  const normalized = prose(value);
  return normalized.length >= 140 ? normalized : `${normalized} ${supplement}`.trim();
}

function stackChoices(blueprint: TechnicalBlueprint) {
  return Object.values(blueprint.recommendedStack)
    .flat()
    .filter((item): item is NonNullable<TechnicalBlueprint["recommendedStack"]["frontend"]> => Boolean(item) && typeof item === "object" && "technology" in item);
}

export function isSubstantialEngineeringTurn(intents: ConversationIntent[]): boolean {
  return intents.some((intent) => SUBSTANTIAL_INTENTS.has(intent));
}

function fallbackGuidance(proposal: PromgentResponseProposal, memory: ProjectMemory, blueprint: TechnicalBlueprint): EngineeringGuidance {
  const activeRequirements = memory.requirements
    .filter((item) => item.status !== "rejected" && item.status !== "superseded")
    .sort((left, right) => Number(right.required) - Number(left.required))
    .map((item) => item.description);
  const criticalGaps = memory.completeness.criticalGaps ?? [];
  const mvpNow = unique([...(memory.mvpScope ?? []), ...activeRequirements], 6);
  const users = memory.users.length ? memory.users.join(" and ") : "the primary user";
  const workflows = memory.workflows?.length
    ? memory.workflows.join(" Then, ")
    : "the user enters the information required for the main task, the system validates it, saves the result, and shows a clear outcome";
  return {
    overview: `${memory.purpose || "This product idea"} should become a focused software product rather than a collection of disconnected features. Its job is to help ${users} complete one valuable outcome reliably, with the complexity hidden behind a clear interface.`,
    assessment: proposal.message,
    productBehavior: `The experience should follow one understandable path: ${workflows}. Every important action needs a visible loading state, a useful success result, and an actionable error when it cannot be completed. Any state the user expects to keep must still be correct after a refresh or a new session.`,
    recommendation: "Build the smallest complete version of the primary journey first. That version should be useful on its own, persist its important state safely, and be testable from the first user action to the final result before optional features are added.",
    rationale: [
      "A complete narrow workflow gives the user something understandable and useful sooner than a wide collection of unfinished features.",
      "Explicit behavior and success criteria make the eventual implementation prompt verifiable instead of a restatement of the idea.",
    ],
    features: mvpNow.map((name) => ({
      name,
      explanation: "This capability should work as a complete interaction rather than a static screen. The interface should explain what input is needed, validate it before changing state, show the result clearly, and preserve confirmed state when the user returns.",
      whyItMatters: "It supports the primary outcome of the first release and gives the team a behavior that can be tested end to end.",
    })),
    mvpNow,
    technicalApproach: `${blueprint.architecture.summary} Keep trusted validation and data changes on the server side, while the browser focuses on explaining the workflow and collecting input. This separation prevents the interface from becoming the only place where important business rules are enforced.`,
    stack: stackChoices(blueprint).map((item) => ({ technology: item.technology, purpose: item.purpose, reason: item.rationale })),
    userJourney: blueprint.workflows.slice(0, 5).map((workflow) => ({
      step: workflow.name,
      explanation: `${workflow.actor} moves through this workflow in order: ${workflow.steps.join(" Then, ")}. If it cannot finish, the product should ${workflow.failureBehavior.join(" and ").toLowerCase() || "show what went wrong without leaving partial state"}.`,
    })),
    screens: blueprint.pages.slice(0, 5).map((page) => ({
      name: page.name,
      purpose: page.purpose,
      keyElements: unique([...page.visibleContent, ...page.actions], 8),
    })),
    architectureExplanation: blueprint.architecture.summary,
    defer: unique(memory.deferredScope ?? [], 5),
    risks: unique([...(memory.risks ?? []), ...criticalGaps.map((gap) => `Unresolved product decision: ${gap}`)], 5),
    riskMitigations: unique([...(memory.risks ?? []), ...criticalGaps], 5).map((risk) => ({
      risk,
      mitigation: "Resolve this as an explicit product rule and cover the normal, invalid, and interrupted paths with acceptance criteria before implementation is considered complete.",
    })),
    nextDecision: memory.nextRecommendedAction?.label,
  };
}

function featureSections(guidance: EngineeringGuidance): string[] {
  const features = guidance.features?.length
    ? guidance.features
    : guidance.mvpNow.map((name) => ({
        name,
        explanation: "This should be implemented as a complete, testable user interaction with clear loading, success, empty, and failure behavior.",
        whyItMatters: "It contributes directly to the first useful version of the product.",
      }));
  if (!features.length) return [];
  return [
    "",
    "## What the first version should include",
    ...features.flatMap((feature, index) => [
      "",
      `### ${index + 1}. ${prose(feature.name)}`,
      ensureDetailed(feature.explanation, "The interaction should explain the required input, validate it before changing state, show an unmistakable outcome, and recover without losing safe user input when something fails."),
      ...(feature.whyItMatters ? ["", `**Why it matters:** ${prose(feature.whyItMatters)}`] : []),
    ]),
  ];
}

function journeySections(guidance: EngineeringGuidance): string[] {
  if (!guidance.userJourney?.length) return [];
  return [
    "",
    "## How the user moves through the product",
    ...guidance.userJourney.flatMap((item, index) => ["", `### Step ${index + 1} — ${prose(item.step)}`, ensureDetailed(item.explanation, "At this point, the interface should make the next action obvious, show progress while the system works, and explain both the successful result and any recoverable failure.")]),
  ];
}

function screenSections(guidance: EngineeringGuidance): string[] {
  if (!guidance.screens?.length) return [];
  return [
    "",
    "## Suggested screens",
    ...guidance.screens.flatMap((screen) => [
      "",
      `### ${prose(screen.name)}`,
      ensureDetailed(screen.purpose, "This screen should focus on one primary action, preserve useful context, and give the user clear loading, empty, success, and error feedback instead of exposing implementation details."),
      ...(screen.keyElements.length ? ["", `The screen should make these elements easy to find: ${screen.keyElements.map(prose).join(", ")}.`] : []),
    ]),
  ];
}

function stackSections(guidance: EngineeringGuidance): string[] {
  if (!guidance.stack?.length) return [];
  return [
    "",
    "### Recommended stack and why",
    ...guidance.stack.flatMap((item) => ["", `**${prose(item.technology)} — ${prose(item.purpose)}.** ${ensureDetailed(item.reason, "It keeps the first version understandable to a beginner, reduces unnecessary infrastructure, and still leaves a clear path for the product to grow.")}`]),
  ];
}

function riskSections(guidance: EngineeringGuidance): string[] {
  if (guidance.riskMitigations?.length)
    return [
      "",
      "## Important risks and how to handle them",
      ...guidance.riskMitigations.flatMap((item) => ["", `**Risk:** ${prose(item.risk)}`, `**How to handle it:** ${ensureDetailed(item.mitigation, "Turn the rule into server-side validation and an explicit acceptance test, then give the user a safe, actionable recovery path when the rule is triggered.")}`]),
    ];
  if (!guidance.risks.length) return [];
  return [
    "",
    "## Important risks and unknowns",
    ...guidance.risks.flatMap((risk) => ["", `**${prose(risk)}.** This should become an explicit product rule and a testable failure case before the build is considered complete.`]),
  ];
}

/** Turn structured analysis into a prose-led, beginner-readable engineering response. */
export function formatEngineeringGuidance(input: {
  proposal: PromgentResponseProposal;
  memory: ProjectMemory;
  intents: ConversationIntent[];
}): string {
  if (!isSubstantialEngineeringTurn(input.intents)) return input.proposal.message;
  const blueprint = buildTechnicalBlueprint({ memory: input.memory });
  const guidance = input.proposal.guidance ?? fallbackGuidance(input.proposal, input.memory, blueprint);
  const showDiagram = input.intents.some((intent) => DIAGRAM_INTENTS.has(intent));
  const overview = prose(guidance.overview || guidance.assessment || input.proposal.message);
  const behavior = prose(guidance.productBehavior || `The first version should guide the primary user through ${blueprint.workflows.map((item) => item.name).join(", ") || "one complete success path"}. It should explain what is happening, preserve important state, and recover safely when an operation fails.`);
  const technicalApproach = prose(guidance.technicalApproach || blueprint.architecture.summary);
  const sections = [
    "## What this product is",
    overview,
    ...(guidance.assessment && prose(guidance.assessment) !== overview ? ["", prose(guidance.assessment)] : []),
    "",
    "## How it should work",
    behavior,
    "",
    "## My recommendation",
    prose(guidance.recommendation),
    ...(guidance.rationale.length ? ["", `This direction is recommended because ${guidance.rationale.map(prose).join(" ")}`] : []),
    ...featureSections(guidance),
    ...journeySections(guidance),
    ...screenSections(guidance),
    "",
    "## Technical approach",
    technicalApproach,
    ...stackSections(guidance),
  ];
  if (showDiagram)
    sections.push(
      "",
      "## Architecture at a glance",
      prose(guidance.architectureExplanation || blueprint.architecture.summary),
      "",
      "```mermaid",
      blueprint.architecture.mermaid,
      "```",
    );
  sections.push(...riskSections(guidance));
  if (guidance.defer.length)
    sections.push("", "## What to leave for later", `Keep ${guidance.defer.map(prose).join(", ")} outside the first release. These can be reconsidered after the primary journey is working and users have shown which additions are genuinely valuable.`);
  if (guidance.nextDecision)
    sections.push("", "## The next useful decision", prose(guidance.nextDecision));
  return sections.join("\n").trim();
}
