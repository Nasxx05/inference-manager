/**
 * Turns raw request input into validated references.
 *
 * Two sources feed this:
 *   - URLs typed into the task text (detected, not moved)
 *   - images uploaded alongside the request
 *
 * The task text is NEVER rewritten. The URL stays where the user typed it; the
 * reference is recorded separately. That preserves originalTask exactly while
 * giving the planner structured reference input.
 */

import { MAX_REFERENCES, type ReferenceInput } from "./types";
import { checkUrl, detectUrls } from "./urlSafety";
import { checkImage } from "./imageValidation";

export interface NormalizeOk {
  ok: true;
  references: ReferenceInput[];
}

export interface NormalizeFail {
  ok: false;
  code: string;
  message: string;
}

export type NormalizeResult = NormalizeOk | NormalizeFail;

/**
 * Builds the reference list for one request.
 *
 * Returns an empty array — not an error — when there is nothing to reference,
 * which is what keeps the text-only path untouched.
 */
export function normalizeReferences(input: {
  taskDescription: string;
  images?: { buffer: Buffer; mimeType?: string; filename?: string }[];
  /** URLs supplied explicitly by the client, if any. */
  urls?: string[];
}): NormalizeResult {
  const references: ReferenceInput[] = [];

  // Existing URLs in the task text become website references.
  const detected = [...detectUrls(input.taskDescription), ...(input.urls ?? [])];
  for (const url of detected) {
    const check = checkUrl(url);
    if (!check.ok) return { ok: false, code: check.code, message: check.message };
    references.push({ type: "website", url: check.url });
  }

  for (const image of input.images ?? []) {
    const check = checkImage({
      buffer: image.buffer,
      ...(image.mimeType ? { declaredMimeType: image.mimeType } : {}),
      ...(image.filename ? { filename: image.filename } : {}),
    });
    if (!check.ok) return { ok: false, code: check.code, message: check.message };
    references.push(check.reference);
  }

  if (references.length > MAX_REFERENCES) {
    return {
      ok: false,
      code: "TOO_MANY_REFERENCES",
      message: `At most ${MAX_REFERENCES} references are supported per request.`,
    };
  }

  return { ok: true, references };
}

/** True when this request has nothing to inspect. */
export function hasReferences(references: ReferenceInput[]): boolean {
  return Array.isArray(references) && references.length > 0;
}

/** Short label for logs and the UI. Never contains user content. */
export function describeReferences(references: ReferenceInput[]): string {
  const images = references.filter((r) => r.type === "image").length;
  const websites = references.filter((r) => r.type === "website").length;
  const parts: string[] = [];
  if (images) parts.push(`${images} image`);
  if (websites) parts.push(`${websites} website`);
  return parts.join(", ");
}