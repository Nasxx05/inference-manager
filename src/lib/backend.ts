/**
 * Where the AgentFund backend lives.
 *
 * The browser calls the backend directly rather than going through a Next.js
 * route, because writing a prompt takes minutes and a serverless function
 * would time out long before it finished. This means the backend URL is public
 * by necessity: it ships in the JavaScript bundle. It is therefore only ever a
 * URL, never a credential, and the AI key stays on the backend.
 */

const FALLBACK = "http://localhost:10000";

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The backend base URL. Set NEXT_PUBLIC_BACKEND_URL at build time on Vercel.
 * Falls back to localhost for development.
 */
export function backendUrl(): string {
  const raw = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!raw || !raw.trim()) return FALLBACK;
  return normalize(raw);
}

/** Full URL for a backend endpoint such as "/api/plan". */
export function endpoint(path: string): string {
  return `${backendUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}