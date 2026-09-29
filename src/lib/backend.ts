/**
 * Where the Promgent backend lives.
 *
 * Production browser calls use the `/backend` external rewrite configured in
 * next.config.mjs. The rewrite is a proxy rule rather than a serverless route,
 * and makes authentication cookies first-party on the Promgent origin. Local
 * development continues to call the configured backend directly.
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
  return isProduction() ? "/backend" : normalize(raw);
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
