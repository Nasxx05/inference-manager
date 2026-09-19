/**
 * JSON extraction from model output.
 *
 * Shared by every structured path so there is exactly one implementation.
 * Model output routinely arrives fenced, prefixed with polite prose, or
 * followed by commentary, so parsing has to be tolerant — but it must still
 * fail clearly when there is genuinely no JSON object to parse.
 */

/** Pulls a JSON object out of a response that may be fenced or prefixed. */
export function extractJson(text: string): unknown {
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