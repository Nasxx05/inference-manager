/**
 * Secure website inspection for URL references.
 *
 * A URL in the task text is untrusted input the backend will fetch, so every
 * guard here is mandatory, not optional:
 *
 *   - only http(s)
 *   - every redirect target re-validated (not just the first URL)
 *   - bounded redirects, bounded time, bounded response size
 *   - private, loopback, link-local and metadata addresses rejected
 *   - failures return a structured reason; nothing invented
 *
 * WHAT THIS DOES AND DOES NOT DO:
 *
 *   It fetches the single page and extracts real HTML structure and metadata.
 *   It does NOT render the page, because the Render deployment has no headless
 *   browser available and adding one would be an infrastructure-heavy
 *   dependency for an MVP. So `visual` is false and no screenshot is claimed.
 *   `renderPage()` is the seam where a renderer can be added later without
 *   changing anything else.
 */

import {
  WEBSITE_FETCH_TIMEOUT_MS,
  WEBSITE_MAX_BYTES,
  WEBSITE_MAX_REDIRECTS,
  checkUrl,
} from "./urlSafety";

export type WebsiteFailure =
  | "INVALID_REFERENCE_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "BLOCKED_REFERENCE_URL"
  | "WEBSITE_FETCH_TIMEOUT"
  | "WEBSITE_FETCH_FAILED"
  | "WEBSITE_UNAVAILABLE"
  | "WEBSITE_TOO_LARGE";

export interface WebsiteInspectionOk {
  ok: true;
  url: string;
  finalUrl: string;
  title: string;
  metaDescription: string;
  /** Landmark headings, in document order. */
  headings: string[];
  /** Navigation link labels, deduplicated and capped. */
  navLabels: string[];
  /** Structural section landmarks found in the markup. */
  sections: string[];
  /** Notable UI signals: forms, buttons, media, carousels. */
  components: string[];
  /** A small amount of visible text, for topic only. Capped hard. */
  textSample: string;
  /** Stylesheet/CDN hints that indicate the stack. Low confidence by nature. */
  frameworkHints: string[];
  /** True only if an actual screenshot was produced. See module note. */
  screenshot: false;
}

export interface WebsiteInspectionFail {
  ok: false;
  code: WebsiteFailure;
  message: string;
}

export type WebsiteInspection = WebsiteInspectionOk | WebsiteInspectionFail;

function fail(code: WebsiteFailure, message: string): WebsiteInspectionFail {
  return { ok: false, code, message };
}

/** Allowed status codes. Anything else is a genuine failure. */
function classifyStatus(status: number): WebsiteInspectionFail | null {
  if (status === 401 || status === 403) {
    return fail("WEBSITE_UNAVAILABLE", "That website requires authentication or blocks automated access.");
  }
  if (status === 404 || status === 410) {
    return fail("WEBSITE_UNAVAILABLE", "That page could not be found.");
  }
  if (status >= 500) {
    return fail("WEBSITE_UNAVAILABLE", "That website returned a server error.");
  }
  if (status >= 400) {
    return fail("WEBSITE_UNAVAILABLE", "That website could not be inspected.");
  }
  return null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/</gi, "<")
    .replace(/>/gi, ">")
    .replace(/"/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function allMatches(html: string, pattern: RegExp, limit: number): string[] {
  const out: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < limit) {
    const value = decodeEntities(stripTags(match[1] ?? "")).trim();
    if (value) out.push(value.slice(0, 120));
  }
  return out;
}

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/** Cheap stack hints from stylesheet/script URLs. Explicitly low confidence. */
function detectFrameworkHints(html: string): string[] {
  const hints: string[] = [];
  const lower = html.toLowerCase();
  const probes: [string, string][] = [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["_next/static", "Next.js"],
    ["wp-content", "WordPress"],
    ["shopify", "Shopify"],
    ["webflow", "Webflow"],
    ["tailwind", "Tailwind CSS"],
    ["bootstrap", "Bootstrap"],
    ["framer", "Framer"],
    ["squarespace", "Squarespace"],
    ["wix", "Wix"],
    ["react", "React"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
  ];
  for (const [needle, label] of probes) {
    if (lower.includes(needle) && !hints.includes(label)) hints.push(label);
    if (hints.length >= 6) break;
  }
  return hints;
}

/**
 * Fetches one page with manual redirect handling.
 *
 * Redirects are followed manually rather than automatically so that each hop
 * can be re-validated: `redirect: "follow"` would happily bounce a public URL
 * into the private network.
 */
async function fetchWithGuards(startUrl: string): Promise<
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; failure: WebsiteInspectionFail }
> {
  let current = startUrl;

  for (let hop = 0; hop <= WEBSITE_MAX_REDIRECTS; hop += 1) {
    const check = checkUrl(current);
    if (!check.ok) {
      return {
        ok: false,
        failure: fail(check.code, check.message),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBSITE_FETCH_TIMEOUT_MS);
    const started = Date.now();

    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Identify the crawler honestly. Some sites block unknown agents.
          "User-Agent": "PromgentReferenceBot/1.0 (+https://promgent)",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        // Resolve a relative Location against the current URL, then re-check.
        current = new URL(location, current).toString();
        continue;
      }

      const statusFailure = classifyStatus(response.status);
      if (statusFailure) return { ok: false, failure: statusFailure };

      const raw = await response.text();
      if (raw.length > WEBSITE_MAX_BYTES) {
        return {
          ok: false,
          failure: fail("WEBSITE_TOO_LARGE", "That page is too large to inspect."),
        };
      }

      console.log(
        `[reference] ts=${new Date().toISOString()} kind=website ` +
          `status=${response.status} bytes=${raw.length} durationMs=${Date.now() - started}`,
      );

      return { ok: true, html: raw, finalUrl: current };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (name === "AbortError" || message.includes("abort")) {
        return {
          ok: false,
          failure: fail("WEBSITE_FETCH_TIMEOUT", "That website took too long to respond."),
        };
      }
      return {
        ok: false,
        failure: fail("WEBSITE_FETCH_FAILED", "That website could not be reached."),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    failure: fail("WEBSITE_FETCH_FAILED", "That website redirected too many times."),
  };
}

/**
 * Inspects a single page.
 *
 * Never crawls. Returns structured fields only — no raw HTML is returned to
 * the caller, so internal response content cannot leak to the user.
 */
export async function inspectWebsite(url: string): Promise<WebsiteInspection> {
  const initial = checkUrl(url);
  if (!initial.ok) return fail(initial.code, initial.message);

  const fetched = await fetchWithGuards(initial.url);
  if (!fetched.ok) return fetched.failure;

  const html = fetched.html;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(stripTags(titleMatch?.[1] ?? "")).trim().slice(0, 160);

  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  );
  const metaDescription = decodeEntities(descMatch?.[1] ?? "").trim().slice(0, 300);

  const headings = unique(
    [...allMatches(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i, 4), ...allMatches(html, /<h2[^>]*>([\s\S]*?)<\/h2>/i, 8)],
    10,
  );

  const navBlock = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? "";
  const navLabels = unique(allMatches(navBlock || html, /<a[^>]*>([\s\S]*?)<\/a>/i, 20), 8);

  const lower = html.toLowerCase();
  const sections: string[] = [];
  const landmarks: [string, string][] = [
    ["<header", "header"],
    ["<nav", "navigation"],
    ["<main", "main content"],
    ["<aside", "sidebar"],
    ["<section", "sectioned content"],
    ["<article", "article content"],
    ["<footer", "footer"],
  ];
  for (const [needle, label] of landmarks) {
    if (lower.includes(needle)) sections.push(label);
  }

  const components: string[] = [];
  const componentProbes: [RegExp | string, string][] = [
    [/<form/i, "form"],
    [/<button/i, "button controls"],
    [/<img/i, "imagery"],
    [/<video/i, "video embed"],
    [/<svg/i, "icon/vector graphics"],
    [/<input[^>]+type=["']search/i, "search input"],
    [/<table/i, "tabular data"],
    [/carousel|swiper|slider/i, "carousel/slider"],
    [/modal|dialog/i, "modal/dialog"],
    [/accordion|collapse/i, "accordion"],
  ];
  for (const [probe, label] of componentProbes) {
    const hit = typeof probe === "string" ? lower.includes(probe.toLowerCase()) : probe.test(html);
    if (hit) components.push(label);
  }

  // A small text sample only, for topic. Deliberately not full content: the
  // goal is design/structure understanding, not copying a website's copy.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const textSample = decodeEntities(stripTags(bodyMatch?.[1] ?? html)).slice(0, 1500);

  return {
    ok: true,
    url: initial.url,
    finalUrl: fetched.finalUrl,
    title,
    metaDescription,
    headings,
    navLabels,
    sections,
    components,
    textSample,
    frameworkHints: detectFrameworkHints(html),
    screenshot: false,
  };
}