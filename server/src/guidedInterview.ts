import { getModel } from "@/data/models";
import { chat } from "@/lib/ai/chatClient";
import { extractJson } from "@/lib/ai/json";
import { buildProjectContext } from "@/lib/projectMemory/context";
import type { ProjectMemory, ProjectRecord } from "@/types/project";
import { PersistenceError } from "./persistence";

export interface GuidedInterviewInference {
  assistantContent: string;
  model: string;
  requestId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

const SYSTEM_PROMPT = `You are Promgent's requirements-engineering interviewer.
You are helping shape one software project before implementation. Ask one high-value question at a time. Use the compact project memory below to avoid repeating settled details, expose important gaps, and surface contradictions without silently resolving them.

Return only valid JSON with this exact shape:
{"assistantMessage":"..."}

Rules:
- Keep assistantMessage concise and conversational.
- Acknowledge the user's answer briefly, then ask exactly one next question unless the project is ready for specification review.
- Prefer questions about users, workflows, data, security, integrations, constraints, acceptance criteria, and deployment when those areas are still unclear.
- Never invent a user decision or claim that an assumption was confirmed.
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

function assistantText(content: string): string {
  const parsed = extractJson(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const message = String((parsed as { assistantMessage?: unknown }).assistantMessage ?? "").trim();
    if (message) return message.slice(0, 4000);
  }
  const plain = content.trim();
  if (!plain) throw new PersistenceError("ORBIO_INVALID_RESPONSE", "Orbio returned an empty interview response.", 502);
  return plain.slice(0, 4000);
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

  return {
    assistantContent: assistantText(result.content),
    model: result.model,
    requestId: result.requestId,
    usage: result.usage
      ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
      : undefined,
  };
}
