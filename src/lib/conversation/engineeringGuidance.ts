import type { ConversationIntent, EngineeringGuidance, PromgentResponseProposal } from "@/types/conversation";
import type { ProjectMemory } from "@/types/project";

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

function unique(values: Array<string | undefined>, limit: number): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, limit);
}

function bullets(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

export function isSubstantialEngineeringTurn(intents: ConversationIntent[]): boolean {
  return intents.some((intent) => SUBSTANTIAL_INTENTS.has(intent));
}

function fallbackGuidance(proposal: PromgentResponseProposal, memory: ProjectMemory): EngineeringGuidance {
  const activeRequirements = memory.requirements
    .filter((item) => item.status !== "rejected" && item.status !== "superseded")
    .sort((left, right) => Number(right.required) - Number(left.required))
    .map((item) => item.description);
  const criticalGaps = memory.completeness.criticalGaps ?? [];
  const mvpNow = unique([...(memory.mvpScope ?? []), ...activeRequirements], 6);
  const recommendedStack = memory.confirmedStack?.length ? memory.confirmedStack : memory.proposedStack ?? [];
  return {
    assessment: proposal.message,
    recommendation: recommendedStack.length
      ? `Use the current ${memory.confirmedStack?.length ? "confirmed" : "proposed"} direction (${recommendedStack.slice(0, 4).join(", ")}) and validate the primary workflow before expanding the build.`
      : "Keep the first release centered on one complete user journey, then choose the simplest stack that can deliver and persist that journey safely.",
    rationale: [
      "A complete narrow workflow gives you something testable and useful sooner than a wide collection of unfinished features.",
      "Explicit success criteria make the eventual coding prompt verifiable instead of a restatement of the idea.",
    ],
    mvpNow,
    defer: unique(memory.deferredScope ?? [], 5),
    risks: unique([...(memory.risks ?? []), ...criticalGaps.map((gap) => `Unresolved product decision: ${gap}`)], 5),
    nextDecision: memory.nextRecommendedAction?.label,
  };
}

/** Turn structured analysis into a beginner-readable engineering response. */
export function formatEngineeringGuidance(input: {
  proposal: PromgentResponseProposal;
  memory: ProjectMemory;
  intents: ConversationIntent[];
}): string {
  if (!isSubstantialEngineeringTurn(input.intents)) return input.proposal.message;
  const guidance = input.proposal.guidance ?? fallbackGuidance(input.proposal, input.memory);
  const sections = [
    "## Engineering assessment",
    guidance.assessment || input.proposal.message,
    "",
    "## My recommendation",
    guidance.recommendation,
  ];
  if (guidance.rationale.length) sections.push("", "### Why this direction", bullets(guidance.rationale));
  if (guidance.mvpNow.length) sections.push("", "### Build in the MVP", bullets(guidance.mvpNow));
  if (guidance.defer.length) sections.push("", "### Leave for later", bullets(guidance.defer));
  if (guidance.risks.length) sections.push("", "### Risks or unknowns", bullets(guidance.risks));
  if (guidance.nextDecision) sections.push("", "### Next decision", guidance.nextDecision);
  return sections.join("\n").trim();
}
