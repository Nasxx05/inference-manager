/**
 * Turns a reference into a structured ReferenceAnalysis.
 *
 * A reference is never used to write the final prompt directly. It is first
 * understood: what kind of thing is this, what is its structure, what is its
 * visual language. That structured understanding is what the planner and the
 * prompt generator consume.
 *
 * Two important rules:
 *
 *  1. Uncertainty is recorded, not invented. If the model cannot tell, the
 *     field goes into `uncertainties` rather than being guessed.
 *  2. `visual` is only true when real pixels were analyzed. A DOM-only website
 *     inspection cannot honestly claim to know typography or colour, so it
 *     reports `visual: false` instead of fabricating a palette.
 */

import { chat, type ChatMessage, type MessageContentPart } from "@/lib/ai/chatClient";
import { AiError, toAiError } from "@/lib/ai/errors";
import {
  aiMultimodalConfigured,
  aiMultimodalModel,
  aiProviderConfigured,
  aiReferenceMaxTokens,
  missingConfig,
} from "@/lib/ai/env";
import { extractJson } from "@/lib/ai/json";
import { inspectWebsite, type WebsiteInspection } from "./websiteInspector";
import type { ImageReferenceInput, ReferenceAnalysis, ReferenceType } from "./types";

const ANALYSIS_SYSTEM = `You analyse a design reference for Promgent, a task-planning tool.

You are NOT writing the final prompt. You are producing a structured understanding of a
reference so another system can plan a task that reproduces its characteristics.

Rules:
- Describe ONLY what you can actually observe. Do not guess, do not embellish.
- Anything you cannot determine confidently goes in "uncertainties". It is far better to
  report uncertainty than to invent a detail.
- Focus on implementation-relevant characteristics: layout hierarchy, section order,
  typography direction, spacing, colour direction, component patterns, interaction cues.
- Never reproduce proprietary copy, logos, or brand assets verbatim. Describe instead.
- Return ONLY valid JSON, no fences, no commentary.`;

const ANALYSIS_SHAPE = `{
  "kind": "visual_web_reference|visual_design_reference|other",
  "summary": "2-3 sentences: what this is and what characterises it",
  "layout": {
    "navigation": "...",
    "hero": "...",
    "sections": "...",
    "footer": "..."
  },
  "visualStyle": {
    "colors": ["..."],
    "typography": "...",
    "spacing": "...",
    "borders": "...",
    "imagery": "..."
  },
  "components": ["..."],
  "interactions": ["..."],
  "responsiveObservations": ["..."],
  "notablePatterns": ["..."],
  "uncertainties": ["..."]
}`;

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function asString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text.slice(0, 400) : undefined;
}

/**
 * Normalises raw analyzer JSON into a ReferenceAnalysis.
 *
 * Missing fields become emptiness or uncertainty — never a fabricated value.
 */
function normalize(
  raw: unknown,
  id: string,
  type: ReferenceType,
  visual: boolean,
  source: string,
): ReferenceAnalysis {
  const value = (raw ?? {}) as Record<string, unknown>;
  const layout = (value.layout ?? {}) as Record<string, unknown>;
  const style = (value.visualStyle ?? {}) as Record<string, unknown>;

  const summary =
    asString(value.summary) ??
    (type === "image"
      ? "An image reference was supplied; its characteristics could not be summarised."
      : "A website reference was supplied; its characteristics could not be summarised.");

  return {
    id,
    type,
    kind: asString(value.kind) ?? "unknown",
    summary,
    layout: {
      ...(asString(layout.navigation) ? { navigation: asString(layout.navigation) } : {}),
      ...(asString(layout.hero) ? { hero: asString(layout.hero) } : {}),
      ...(asString(layout.sections) ? { sections: asString(layout.sections) } : {}),
      ...(asString(layout.footer) ? { footer: asString(layout.footer) } : {}),
    },
    visualStyle: {
      colors: asStringArray(style.colors ?? style.colorPalette, 8),
      ...(asString(style.typography) ? { typography: asString(style.typography) } : {}),
      ...(asString(style.spacing) ? { spacing: asString(style.spacing) } : {}),
      ...(asString(style.borders) ? { borders: asString(style.borders) } : {}),
      ...(asString(style.imagery) ? { imagery: asString(style.imagery) } : {}),
    },
    components: asStringArray(value.components, 12),
    interactions: asStringArray(value.interactions, 8),
    responsiveObservations: asStringArray(value.responsiveObservations, 6),
    notablePatterns: asStringArray(value.notablePatterns, 8),
    uncertainties: asStringArray(value.uncertainties, 8),
    visual,
    source,
  };
}

/** Builds the image message in the provider's expected shape. */
export function buildImageMessage(input: {
  prompt: string;
  image: ImageReferenceInput;
}): ChatMessage[] {
  const parts: MessageContentPart[] = [
    { type: "text", text: input.prompt },
    // A data URL: the provider cannot fetch the user's local file, so the
    // bytes must travel with the request.
    { type: "image_url", image_url: { url: `data:${input.image.mimeType};base64,${input.image.base64}`, detail: "high" } },
  ];

  return [
    { role: "system", content: ANALYSIS_SYSTEM },
    { role: "user", content: parts },
  ];
}

/** Runs one structured analysis call. */
async function analyzeWithModel(
  messages: ChatMessage[],
  requestId?: string,
): Promise<unknown> {
  if (!aiProviderConfigured()) {
    throw new AiError(
      "BACKEND_NOT_CONFIGURED",
      `Promgent's model is not configured. Missing: ${missingConfig().join(", ")}.`,
    );
  }

  const result = await chat({
    messages,
    jsonMode: true,
    maxTokens: aiReferenceMaxTokens(),
    temperature: 0.2,
    stage: "reference-analysis",
    // A multimodal model is used when one is configured; otherwise the default
    // planning model answers, which is correct for text-only website input.
    ...(aiMultimodalConfigured() ? { model: aiMultimodalModel() } : {}),
    ...(requestId ? { requestId } : {}),
  });

  const raw = extractJson(result.content);
  if (raw === null) {
    throw new AiError("AI_INVALID_RESPONSE", "The reference analysis was not valid JSON.", {
      retryable: true,
      requestId: result.requestId,
    });
  }
  return raw;
}

/**
 * Analyzes an uploaded image.
 *
 * Requires a configured multimodal model. When none is configured this fails
 * loudly rather than returning a fabricated analysis — an image the system
 * cannot see must never be described as understood.
 */
export async function analyzeImageReference(
  image: ImageReferenceInput,
  index: number,
  requestId?: string,
): Promise<ReferenceAnalysis> {
  if (!aiMultimodalConfigured()) {
    throw new AiError(
      "REFERENCE_ANALYSIS_FAILED",
      "Image references need a multimodal model. Set AGENTFUND_AI_MULTIMODAL_MODEL on the backend.",
    );
  }

  const prompt =
    "Analyse this image as a design/implementation reference.\n\n" +
    "Identify what it is (page type or artefact type), its layout hierarchy, section " +
    "order, navigation treatment, hero composition, typography characteristics, colour " +
    "palette, spacing and density, border/shadow treatment, imagery style, component " +
    "patterns, and any interaction or animation cues that are visually apparent.\n\n" +
    `Return JSON in this exact shape:\n${ANALYSIS_SHAPE}`;

  const raw = await analyzeWithModel(buildImageMessage({ prompt, image }), requestId);
  return normalize(raw, `ref:image:${index}`, "image", true, "multimodal image analysis");
}

/**
 * Analyzes a website reference from its inspected structure.
 *
 * `visual` is whatever the inspection reports. With no screenshot capability
 * this is false, and the analysis honestly says so instead of inventing a
 * colour palette or type scale.
 */
export async function analyzeWebsiteReference(
  url: string,
  index: number,
  requestId?: string,
): Promise<ReferenceAnalysis> {
  const inspection = await inspectWebsite(url);
  if (!inspection.ok) {
    throw new AiError(inspection.code, inspection.message);
  }
  return analyzeInspection(inspection, index, requestId);
}

/** Analyzes an already-inspected page. Separated so it is testable. */
export async function analyzeInspection(
  inspection: Extract<WebsiteInspection, { ok: true }>,
  index: number,
  requestId?: string,
): Promise<ReferenceAnalysis> {
  // `screenshot` is typed `false` today because no renderer is wired up. It is
  // read rather than assumed, so flipping the inspector to produce real
  // screenshots makes this path visual with no change here.
  const visual: boolean = inspection.screenshot;

  const prompt =
    "Analyse this inspected web page as a design/implementation reference.\n\n" +
    "You are given STRUCTURAL and metadata observations only" +
    (visual ? ", plus a rendered screenshot." : " — NOT a rendered screenshot.") +
    "\n\n" +
    "IMPORTANT: Do not invent visual style. If you were not given pixels, you cannot " +
    "know the colour palette, typography or spacing. Leave those absent and record the " +
    "limitation in \"uncertainties\".\n\n" +
    "PAGE OBSERVATIONS:\n" +
    `- title: ${inspection.title || "(none)"}\n` +
    `- description: ${inspection.metaDescription || "(none)"}\n` +
    `- headings: ${inspection.headings.join(" | ") || "(none)"}\n` +
    `- navigation labels: ${inspection.navLabels.join(" | ") || "(none)"}\n` +
    `- structural landmarks: ${inspection.sections.join(", ") || "(none)"}\n` +
    `- detected components: ${inspection.components.join(", ") || "(none)"}\n` +
    `- stack hints: ${inspection.frameworkHints.join(", ") || "(none)"}\n` +
    `- visible text sample (topic only, do not copy): ${inspection.textSample.slice(0, 600)}\n\n` +
    `Return JSON in this exact shape:\n${ANALYSIS_SHAPE}`;

  const raw = await analyzeWithModel(
    [
      { role: "system", content: ANALYSIS_SYSTEM },
      { role: "user", content: prompt },
    ],
    requestId,
  );

  const analysis = normalize(
    raw,
    `ref:website:${index}`,
    "website",
    visual,
    visual ? "rendered page screenshot" : "page structure and metadata (not rendered)",
  );

  // A non-visual inspection must never imply it judged visual style.
  if (!visual) {
    analysis.uncertainties = [
      "Visual style was not assessed: the page was inspected as structure and metadata, not rendered.",
      ...analysis.uncertainties,
    ].slice(0, 8);
  }

  return analysis;
}

/**
 * Renders an analysis into compact text for the prompt generator.
 *
 * This is the translation step: the reference becomes actionable instructions
 * ("oversized hero typography, restrained palette") rather than
 * "make it like the image", because the target model will not see the image.
 */
export function describeReferenceForPrompt(analysis: ReferenceAnalysis): string {
  const lines: string[] = [`REFERENCE (${analysis.type}): ${analysis.summary}`];

  const layout = [
    analysis.layout.navigation && `navigation: ${analysis.layout.navigation}`,
    analysis.layout.hero && `hero: ${analysis.layout.hero}`,
    analysis.layout.sections && `sections: ${analysis.layout.sections}`,
    analysis.layout.footer && `footer: ${analysis.layout.footer}`,
  ].filter(Boolean) as string[];
  if (layout.length) lines.push(`Layout — ${layout.join("; ")}`);

  const style = [
    analysis.visualStyle.colors.length && `colours: ${analysis.visualStyle.colors.join(", ")}`,
    analysis.visualStyle.typography && `typography: ${analysis.visualStyle.typography}`,
    analysis.visualStyle.spacing && `spacing: ${analysis.visualStyle.spacing}`,
    analysis.visualStyle.borders && `borders/surfaces: ${analysis.visualStyle.borders}`,
    analysis.visualStyle.imagery && `imagery: ${analysis.visualStyle.imagery}`,
  ].filter(Boolean) as string[];
  if (style.length) lines.push(`Visual language — ${style.join("; ")}`);

  if (analysis.components.length) {
    lines.push(`Components — ${analysis.components.join("; ")}`);
  }
  if (analysis.interactions.length) {
    lines.push(`Interactions — ${analysis.interactions.join("; ")}`);
  }
  if (analysis.notablePatterns.length) {
    lines.push(`Patterns — ${analysis.notablePatterns.join("; ")}`);
  }
  if (analysis.responsiveObservations.length) {
    lines.push(`Responsive clues — ${analysis.responsiveObservations.join("; ")}`);
  }
  if (analysis.uncertainties.length) {
    lines.push(`Uncertain, do not assume — ${analysis.uncertainties.join("; ")}`);
  }

  return lines.join("\n");
}

export const __analyzerTesting = { normalize, toAiError };