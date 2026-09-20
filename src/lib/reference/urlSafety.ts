/**
 * URL detection and SSRF validation for website references.
 *
 * Users type URLs into the ordinary task field, so they are untrusted input
 * that the backend will fetch. This module exists to make that safe: only
 * http(s), never a private address, never a cloud metadata endpoint, and every
 * redirect re-checked rather than trusted.
 */

import type { WebsiteReferenceInput } from "./types";

/** Deliberately conservative: enough for real sites, not a crawler. */
export const WEBSITE_FETCH_TIMEOUT_MS = 10_000;
export const WEBSITE_MAX_REDIRECTS = 3;
/** Response body cap. Prevents a huge page exhausting memory. */
export const WEBSITE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Matches http(s) URLs in free text.
 *
 * Requires a scheme so that "example.com" alone is not mistaken for a URL,
 * and stops at whitespace or common sentence punctuation so "see (https://x)"
 * yields "https://x" rather than swallowing the bracket.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]}]+/gi;

/** Trailing punctuation that is sentence structure, not part of the URL. */
const TRAILING = /[.,;:!?]+$/;

export function detectUrls(text: string): string[] {
  if (!text) return [];
  const found = text.match(URL_PATTERN) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of found) {
    const cleaned = raw.replace(TRAILING, "");
    if (!cleaned) continue;
    // Normalise for de-duplication only; the original is preserved in the task.
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export type UrlRejection =
  | "INVALID_REFERENCE_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "BLOCKED_REFERENCE_URL";

export interface UrlCheckOk {
  ok: true;
  url: string;
  hostname: string;
}

export interface UrlCheckFail {
  ok: false;
  code: UrlRejection;
  message: string;
}

export type UrlCheck = UrlCheckOk | UrlCheckFail;

/** True for a dotted hostname or `localhost`; false for a bare intranet name. */
function looksPublic(hostname: string): boolean {
  if (hostname.includes(":")) return false; // IPv6 literal — not supported.
  return hostname.includes(".") || hostname === "localhost";
}

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** True when an IPv4 address sits in any private/special-use range. */
function isPrivateIpv4(ip: string): boolean {
  if (!isIpv4(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return true;

  const [a, b] = parts as [number, number, number, number];
  // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 192.0.0.0/24, 192.0.2.0/24, 198.18/15, 198.51.100/24, 203.0.113/24
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  // 100.64/10 (CGNAT), 224+/multicast, 240+/reserved, 255.255.255.255
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** Hostnames that must never be fetched, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Well-known cloud metadata address. */
const METADATA_IP = "169.254.169.254";

/**
 * Validates one URL for fetching.
 *
 * Pure and synchronous on purpose: it is applied to the initial URL and again
 * to every redirect target, and it is trivially testable without a network.
 */
export function checkUrl(raw: string): UrlCheck {
  const value = String(raw ?? "").trim();
  if (!value) {
    return { ok: false, code: "INVALID_REFERENCE_URL", message: "No URL was supplied." };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      code: "INVALID_REFERENCE_URL",
      message: "That does not look like a valid URL.",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "UNSUPPORTED_PROTOCOL",
      message: "Only http and https references are supported.",
    };
  }

  // Strip credentials: a URL containing them is not one we should fetch.
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: "BLOCKED_REFERENCE_URL",
      message: "That URL cannot be used as a reference.",
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!hostname) {
    return { ok: false, code: "INVALID_REFERENCE_URL", message: "That URL has no host." };
  }

  if (!looksPublic(hostname)) {
    return {
      ok: false,
      code: "BLOCKED_REFERENCE_URL",
      message: "That URL cannot be used as a reference.",
    };
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    return {
      ok: false,
      code: "BLOCKED_REFERENCE_URL",
      message: "That URL cannot be used as a reference.",
    };
  }

  if (isIpv4(hostname)) {
    if (hostname === METADATA_IP || isPrivateIpv4(hostname)) {
      return {
        ok: false,
        code: "BLOCKED_REFERENCE_URL",
        message: "That URL cannot be used as a reference.",
      };
    }
  }

  return { ok: true, url: parsed.toString(), hostname };
}

/** Convenience wrapper used by the reference normalizer. */
export function toWebsiteReference(raw: string): WebsiteReferenceInput | UrlCheckFail {
  const check = checkUrl(raw);
  return check.ok ? { type: "website", url: check.url } : check;
}

export const __testing = { isPrivateIpv4, ipv4ToInt, looksPublic };