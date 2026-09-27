import { getModel } from "@/data/models";
import { chat } from "@/lib/ai/chatClient";
import { extractJson } from "@/lib/ai/json";
import { buildProjectContext } from "@/lib/projectMemory/context";
import type { ProjectMemory, ProjectRecord } from "@/types/project";
import { PersistenceError } from "./persistence";

export interface GuidedInterviewInference {
  assistantContent: string;
  structuredProposal: unknown;
  model: string;
  requestId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

const SYSTEM_PROMPT = `You are Promgent's requirements-engineering interviewer.
You are helping shape one software project before implementation. Ask one high-value question at a time. Use the compact project memory below to avoid repeating settled details, expose important gaps, and surface contradictions without silently resolving them.

Return only valid JSON with this shape:
{
  "assistantMessage":"...",
  "requirements":[{"description":"atomic requirement","type":"functional|business|non_functional|design|technical|data|security|integration","category":"core_functionality|users|workflows|data|integrations|interfaces|security|performance|accessibility|deployment|constraints","priority":"critical|high|medium|low","required":true,"sourceEvidence":"exact supporting words from the user's latest response, or empty when inferred","confidence":"high|medium|low"}],
  "users":[],
  "designPreferences":[],
  "technicalConstraints":[],
  "assumptions":[],
  "acceptanceCriteria":[{"requirementDescription":"the matching requirement","description":"observable testable criterion","sourceEvidence":"exact supporting words from the user, or empty when inferred","confidence":"high|medium|low"}],
  "resolvedQuestionAreas":[],
  "newOpenQuestions":[],
  "possibleContradictions":[]
}

Rules:
- Keep assistantMessage concise and conversational.
- Acknowledge the user's answer briefly, then ask exactly one next question unless the project is ready for specification review.
- Prefer questions about users, workflows, data, security, integrations, constraints, acceptance criteria, and deployment when those areas are still unclear.
- Never invent a user decision or claim that an assumption was confirmed.
- Extract every independently testable behavior as a separate atomic requirement. Never combine auth, payments, ordering, booking, notifications, or admin behavior into one requirement.
- sourceEvidence must quote only the user's latest response. Leave it empty for any useful inference.
- Acceptance criteria must map to one proposed or existing requirement, be observable, and must not introduce unrelated features.
- Do not duplicate requirements already present in Project Memory. Prefer a wording refinement only when it preserves the same behavior.
- Do not discuss API keys, provider billing, or implementation execution.
- Do not use markdown fences.`;

function providerBaseUrl(): string {
  return String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
}

export function providerModelId(selectedModel: string): string {
  const profile = getModel(selectedModel);
  return String(profile?.providerModelId ?? selectedModel).trim();
}

function maxTokens(): number {
  const configured = Number(process.env.ORBIO_INTERVIEW_MAX_TOKENS ?? 700);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.round(configured), 1200)
    : 700;
}

function parsedResponse(content: string): { assistantContent: string; structuredProposal: unknown } {
  const parsed = extractJson(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const message = String((parsed as { assistantMessage?: unknown }).assistantMessage ?? "").trim();
    if (message) return { assistantContent: message.slice(0, 4000), structuredProposal: parsed };
  }
  const plain = content.trim();
  if (!plain) throw new PersistenceError("ORBIO_INVALID_RESPONSE", "Orbio returned an empty interview response.", 502);
  return { assistantContent: plain.slice(0, 4000), structuredProposal: {} };
}

/**
 * Every call here is authenticated with the project's owner's decrypted Orbio
 * key. `retry: false` is intentional: if a provider accepted a request but
 * the response was lost, retrying could charge the same interview turn twice.
 */
export async function runGuidedInterviewInference(input: {
  apiKey: string;
  project: ProjectRecord;
  memory: ProjectMemory;
  userContent?: string;
  opening?: boolean;
}): Promise<GuidedInterviewInference> {
  const baseUrl = providerBaseUrl();
  if (!baseUrl) throw new PersistenceError("ORBIO_NOT_CONFIGURED", "ORBIO_BASE_URL is not configured.");

  const apiKey = input.apiKey.trim();
  const model = providerModelId(input.project.selectedModel);
  if (!apiKey) throw new PersistenceError("ORBIO_NOT_CONNECTED", "Connect an active Orbio key before using the interview.", 400);
  if (!model || model === "auto") throw new PersistenceError("ORBIO_MODEL_REQUIRED", "Choose a concrete Orbio model for the interview.", 400);

  const userContent = input.userContent?.trim() || "No answer has been given yet; begin the requirements interview.";
  const context = buildProjectContext(input.memory, userContent);
  const direction = input.opening
    ? "Start the interview with one useful question based on the initial project idea and its highest-value unknown."
    : "Respond to the user's latest answer and continue the adaptive interview.";

  const result = await chat({
    apiKey,
    baseUrl,
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${direction}\n\n${context}` },
    ],
    maxTokens: maxTokens(),
    temperature: 0.2,
    jsonMode: true,
    stage: "guided-interview",
    retry: false,
  });

  const parsed = parsedResponse(result.content);
  return {
    ...parsed,
    model: result.model,
    requestId: result.requestId,
    usage: result.usage
      ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
      : undefined,
  };
}
