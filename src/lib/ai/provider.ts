import { heuristicAnalyze } from "./taskAnalyzer";
import { aiApiKey, aiBaseUrl, aiModel, aiProviderConfigured } from "./env";
import { AnalysisValidationError, validateAnalysis } from "@/lib/validation/schemas";
import type { TaskAnalysis } from "@/types";

/**
 * AgentFund's INTERNAL planning model. Separate from the user's target model:
 * it only plans and compiles, never executes the task.
 *
 * Configuration is server-side only (AI_API_KEY / AI_BASE_URL / AI_MODEL).
 * When no provider is configured we fall back to deterministic local analysis
 * so the product works out of the box.
 */

const SYSTEM_PROMPT = `You are the planning engine inside AgentFund, a budget-aware AI task planner.
You never execute the user's task. You only analyze it and return structured planning metadata.

Analyse the user's request and return ONLY valid JSON with this exact shape:
{
  "taskType": "coding|web-development|research|writing|document-analysis|data-analysis|planning|creative|general",
  "summary": "one sentence describing the goal",
  "complexity": "low|medium|high|very-high",
  "requiredCapabilities": ["..."],
  "estimatedInputTokens": 0,
  "estimatedOutputTokens": 0,
  "expectedIterations": 0,
  "toolRequirements": ["..."],
  "phases": [{"name": "", "description": "", "priority": "essential|recommended|optional", "costWeight": 0.0}],
  "risks": ["..."],
  "scopeAdjustments": ["..."]
}

Rules:
- estimatedInputTokens/estimatedOutputTokens are realistic totals across all iterations.
- expectedIterations includes validation and revision passes.
- phases must be ordered and appropriate to the task type, not a fixed template.
- costWeight values across phases should sum to about 1.0.
- Be conservative and realistic. Do not inflate or deflate estimates.`;

function providerConfigured(): boolean {
  return aiProviderConfigured();
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callProvider(taskDescription: string): Promise<unknown> {
  const baseUrl = aiBaseUrl();
  const model = aiModel();
  const apiKey = aiApiKey();
  if (!apiKey) throw new Error("No AI API key is configured");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Task description:\n${taskDescription}` },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Provider returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("Provider returned no content");
  return extractJson(content);
}

export async function analyzeTask(
  taskDescription: string,
): Promise<{ analysis: TaskAnalysis; source: "ai" | "heuristic" }> {
  const baseline = heuristicAnalyze(taskDescription);

  if (!providerConfigured()) {
    return { analysis: baseline, source: "heuristic" };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callProvider(taskDescription);
      const analysis = validateAnalysis(raw, baseline);
      return { analysis, source: "ai" };
    } catch (error) {
      if (error instanceof AnalysisValidationError) continue;
      break;
    }
  }

  return { analysis: baseline, source: "heuristic" };
}