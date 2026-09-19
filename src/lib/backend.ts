/**
 * Where the Promgent backend lives.
 *
 * The browser calls the backend directly rather than going through a Next.js
 * route, because writing a prompt takes minutes and a serverless function
 * would time out long before it finished. This means the backend URL is public
 * by necessity: it ships in the JavaScript bundle. It is therefore only ever a
 * URL, never a credential, and the AI key stays on the backend.
 *
 * In production a missing URL is a real failure, not something to paper over:
 * silently defaulting to localhost would send every user's request to their own
 * machine and produce a confusing network error. Development may use localhost;
 * production must fail clearly.
 */

const DEV_FALLBACK = "http://localhost:10000";

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The backend base URL. Set NEXT_PUBLIC_BACKEND_URL at build time on Vercel;
 * redeploy after changing it, because it is inlined into the bundle.
 */
export function backendUrl(): string {
  const raw = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!raw || !raw.trim()) {
    if (isProduction()) {
      throw new Error(
        "NEXT_PUBLIC_BACKEND_URL is not set. Set it to your Render service URL and redeploy.",
      );
    }
    return DEV_FALLBACK;
  }
  return normalize(raw);
}

/** True when a backend URL has actually been configured. Never throws. */
export function backendConfigured(): boolean {
  const raw = process.env.NEXT_PUBLIC_BACKEND_URL;
  return Boolean(raw && raw.trim());
}

/** Full URL for a backend endpoint such as "/api/plan". */
export function endpoint(path: string): string {
  return `${backendUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}