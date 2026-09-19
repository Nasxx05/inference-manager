/**
 * Loads local environment files for development.
 *
 * Production gets its configuration from the Render dashboard, where the
 * variables are already present in `process.env`. Locally there is nothing to
 * populate `process.env`, and a plain `node`/`tsx` process (unlike the Next.js
 * dev server) does not read `.env` files on its own — so the backend would see
 * no AI_* values even though they are sitting in the repo's `.env.local`.
 *
 * This uses Node's built-in `process.loadEnvFile`, which only fills in variables
 * that are *missing* and never overwrites existing ones. That ordering matters:
 * a real value from the host always wins over a file, so this can never shadow
 * or downgrade Render's configuration in production. It is a local convenience,
 * not a second source of truth.
 *
 * Files are tried from most to least specific, so `server/.env.local` beats a
 * root `.env`, and `.env.local` beats `.env`, matching the usual convention.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Candidate files, relative to the backend working directory, in priority order. */
const CANDIDATES = [
  ".env.local",
  ".env",
  resolve("..", ".env.local"),
  resolve("..", ".env"),
];

/**
 * Populates missing environment variables from local files, if any exist.
 *
 * Returns the files that were actually read, so the caller can log them and it
 * is obvious whether configuration came from the host or a local file. Does
 * nothing when the runtime has no `process.loadEnvFile` (Node before 20.12), or
 * when no file is present — in both cases the process simply keeps whatever the
 * host provided, which is the production path.
 */
export function loadLocalEnv(): string[] {
  if (typeof process.loadEnvFile !== "function") return [];

  const loaded: string[] = [];
  for (const candidate of CANDIDATES) {
    const path = resolve(process.cwd(), candidate);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
      loaded.push(candidate);
    } catch {
      // A malformed file must not stop the server from booting; the host's
      // variables (or their absence) still decide the configuration.
    }
  }
  return loaded;
}
