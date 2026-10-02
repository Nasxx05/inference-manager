import type { ConversationIntent } from "@/types/conversation";

const rules: Array<[ConversationIntent, RegExp]> = [
  ["repository_review", /github\.com\/[\w.-]+\/[\w.-]+|review (?:my |the )?(?:repo|repository|code)|i (?:built|implemented|pushed) it/i],
  ["live_product_review", /https?:\/\/(?!github\.com)|review (?:my |the )?(?:site|app|product)|live (?:site|app|url)/i],
  ["architecture_request", /(?:show|create|generate|draw|give).{0,64}architecture|how (?:does|will) (?:it|everything) connect/i],
  ["architecture_discussion", /architecture|tech stack|how should (?:it|this) work/i],
  ["credit_estimate_request", /(?:how much|estimate|budget|cost).{0,30}(?:credit|inference)|credit.{0,20}(?:estimate|need|cost)/i],
  ["testing_request", /(?:run|execute|check).{0,16}tests?|test (?:this|the|my)|ci (?:status|result|failed)/i],
  ["prompt_generation", /(?:generate|create|write|give me).{0,64}(?:implementation |coding |build )?prompt|(?:fix|build|cursor|codex|cline) prompt/i],
  ["build_plan_request", /(?:build|implementation|development) plan|what (?:do|should) (?:i|we) build first/i],
  ["next_step_request", /what (?:should|do) (?:i|we) do next|what(?:'s| is) next|next step/i],
  ["debugging_help", /(?:why|help).{0,30}(?:fail|error|broken|crash)|debug|doesn'?t work/i],
  ["technical_explanation", /^(?:what is|what are|why do|why does|explain|i don'?t understand|how does)\b/i],
  ["change_request", /\b(?:actually|instead|change|replace|remove|forget|defer|add|include|exclude|don'?t need|do not need)\b/i],
  ["requirement_change", /\b(?:must|should|need(?:s)? to|has to|require(?:ment)?)\b/i],
  ["artifact_request", /(?:show|view|export|copy).{0,24}(?:blueprint|specification|srs|plan|artifact)/i],
];

export function routeConversationIntents(message: string): ConversationIntent[] {
  const content = message.trim();
  if (!content) return ["general_guidance"];
  const matches = rules.filter(([, pattern]) => pattern.test(content)).map(([intent]) => intent);
  const specific = [...new Set(matches)];
  if (specific.length) return specific.slice(0, 4);
  return content.length < 120 && /\?$/.test(content)
    ? ["project_question"]
    : ["project_discovery"];
}

export function intentMayChangeProject(intent: ConversationIntent): boolean {
  return ["project_discovery", "requirement_change", "change_request"].includes(intent);
}
