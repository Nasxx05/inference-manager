/**
 * Adds the .js extension to relative import/export specifiers in the compiled
 * output.
 *
 * Node's ESM loader requires a full file path, but the shared sources are
 * written for Next's bundler and omit the extension. tsc-alias resolves the
 * "@/..." aliases but leaves these relative ones untouched, so this pass
 * finishes the job. It only rewrites a specifier when the corresponding file
 * actually exists on disk, so package imports like "express" are never
 * touched and the shared sources stay valid for Next and Vitest.
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Captures the specifier in import/export ... from "..." statements. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']*?)\2/g;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...(await walk(full)));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Collects the specifiers in one file that need the extension added. */
async function pendingRewrites(file, source) {
  const matches = [...source.matchAll(SPECIFIER)];
  const rewrites = [];

  for (const match of matches) {
    const [full, keyword, quote, specifier] = match;
    if (specifier.endsWith(".js")) continue;
    if (!(await isFile(resolve(dirname(file), `${specifier}.js`)))) continue;
    rewrites.push({ from: full, to: `${keyword}${quote}${specifier}.js${quote}` });
  }

  return rewrites;
}

async function rewrite(file) {
  const source = await readFile(file, "utf8");
  const rewrites = await pendingRewrites(file, source);
  if (rewrites.length === 0) return false;

  let next = source;
  for (const { from, to } of rewrites) {
    next = next.split(from).join(to);
  }
  await writeFile(file, next);
  return true;
}

const files = await walk(DIST);
let modified = 0;
for (const file of files) {
  if (await rewrite(file)) modified += 1;
}

console.log(`ESM import fix: checked ${files.length} files, updated ${modified}.`);