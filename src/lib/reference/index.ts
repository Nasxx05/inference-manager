/**
 * Reference processing: the orchestration seam between a raw request and the
 * planner.
 *
 * The planner stays responsible for orchestration of PLANNING only. This module
 * owns reference-specific work: validating uploads, detecting URLs, inspecting
 * websites and asking the multimodal model for a structured understanding.
 *
 * It runs exactly ONE analysis per reference and caches the result in the
 * request, so cost, scope and prompt all receive the same object.
 */

import { AiError } from "@/lib/ai/errors";
import { analyzeImageReference, analyzeWebsiteReference } from "./referenceAnalyzer";
import { normalizeReferences } from "./normalizer";
import type { ReferenceAnalysis, ReferenceInput } from "./types";

export * from "./types";
export { detectUrls, checkUrl } from "./urlSafety";
export { checkImage, isSupportedExtension, isSupportedMimeType, sanitizeFilename } from "./imageValidation";
export { normalizeReferences, describeReferences, hasReferences } from "./normalizer";
export { inspectWebsite } from "./websiteInspector";
export { describeReferenceForPrompt } from "./referenceAnalyzer";
export { referenceWorkload } from "./workload";

export interface ReferencesOk {
  ok: true;
  references: ReferenceInput[];
  analyses: ReferenceAnalysis[];
  /** Milliseconds spent on reference processing. Diagnostic only. */
  durationMs: number;
}

export interface ReferencesFail {
  ok: false;
  code: string;
  message: string;
}

export type ReferencesResult = ReferencesOk | ReferencesFail;

/**
 * Validates and analyzes every reference for one request.
 *
 * Returns empty arrays with zero work when there is nothing to process: the
 * text-only path never pays for validation, fetching, or a model call.
 */
export async function processReferences(input: {
  taskDescription: string;
  images?: { buffer: Buffer; mimeType?: string; filename?: string }[];
  urls?: string[];
  requestId?: string;
}): Promise<ReferencesResult> {
  const started = Date.now();

  const normalized = normalizeReferences({
    taskDescription: input.taskDescription,
    ...(input.images ? { images: input.images } : {}),
    ...(input.urls ? { urls: input.urls } : {}),
  });

  if (!normalized.ok) {
    return { ok: false, code: normalized.code, message: normalized.message };
  }

  const references = normalized.references;
  if (references.length === 0) {
    return { ok: true, references: [], analyses: [], durationMs: 0 };
  }

  const analyses: ReferenceAnalysis[] = [];
  let imageIndex = 0;
  let websiteIndex = 0;

  for (const reference of references) {
    // One analysis per reference, cached in `analyses` for the whole request.
    if (reference.type === "image") {
      analyses.push(
        await analyzeImageReference(reference, imageIndex, input.requestId),
      );
      imageIndex += 1;
    } else {
      analyses.push(
        await analyzeWebsiteReference(reference.url, websiteIndex, input.requestId),
      );
      websiteIndex += 1;
    }
  }

  const durationMs = Date.now() - started;
  console.log(
    `[reference] ts=${new Date().toISOString()} kind=summary ` +
      `count=${references.length} durationMs=${durationMs} ` +
      `requestId=${input.requestId ?? "-"}`,
  );

  return { ok: true, references, analyses, durationMs };
}

/** Wraps a reference failure as a structured AiError with a stable code. */
export function referenceError(code: string, message: string): AiError {
  const known = [
    "UNSUPPORTED_IMAGE_TYPE",
    "IMAGE_TOO_LARGE",
    "EMPTY_IMAGE",
    "TOO_MANY_REFERENCES",
    "INVALID_REFERENCE_URL",
    "UNSUPPORTED_PROTOCOL",
    "BLOCKED_REFERENCE_URL",
    "WEBSITE_FETCH_TIMEOUT",
    "WEBSITE_FETCH_FAILED",
    "WEBSITE_UNAVAILABLE",
    "WEBSITE_TOO_LARGE",
    "REFERENCE_ANALYSIS_FAILED",
  ] as const;

  type Known = (typeof known)[number];
  const safe: Known = (known as readonly string[]).includes(code)
    ? (code as Known)
    : "REFERENCE_ANALYSIS_FAILED";

  return new AiError(safe, message);
}