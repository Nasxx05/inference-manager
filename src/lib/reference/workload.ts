/**
 * How much planning work references add.
 *
 * This extends the EXISTING estimator rather than replacing it: references
 * contribute the same kinds of signals the estimator already understands
 * (extra requirements, an effort multiplier), so the deterministic cost engine
 * is unchanged and the arithmetic stays transparent.
 *
 * The numbers are deliberately modest. A reference adds real planning work —
 * more requirements to reconcile, more prompt context — but it must not
 * dominate the estimate or look like a invented surcharge.
 */

import type { ReferenceAnalysis, ReferenceWorkload } from "./types";

/** Extra requirement weight per reference type. */
const ADDED_REQUIREMENTS: Record<ReferenceAnalysis["type"], number> = {
  // An image carries concrete design constraints to honour.
  image: 2,
  // A website adds structure and component expectations.
  website: 1,
};

/** Effort multiplier increment per reference type. */
const EFFORT_INCREMENT: Record<ReferenceAnalysis["type"], number> = {
  image: 0.08,
  website: 0.05,
};

/** Cap so a pile of references cannot inflate the estimate without bound. */
const MAX_ADDED_REQUIREMENTS = 4;
const MAX_EFFORT_MULTIPLIER = 1.2;

/**
 * Computes the planning workload contributed by references.
 *
 * Returns a no-op workload for an empty list, which is what keeps text-only
 * planning numerically identical to before.
 */
export function referenceWorkload(analyses: ReferenceAnalysis[]): ReferenceWorkload {
  if (!analyses.length) {
    return { addedRequirements: 0, effortMultiplier: 1, driver: "" };
  }

  let added = 0;
  let multiplier = 1;

  for (const item of analyses) {
    added += ADDED_REQUIREMENTS[item.type] ?? 1;
    multiplier += EFFORT_INCREMENT[item.type] ?? 0.05;
  }

  const images = analyses.filter((a) => a.type === "image").length;
  const websites = analyses.filter((a) => a.type === "website").length;

  const parts: string[] = [];
  if (images) parts.push("Image reference analysis adds planning work.");
  if (websites) parts.push("Website reference inspection adds planning overhead.");

  return {
    addedRequirements: Math.min(MAX_ADDED_REQUIREMENTS, added),
    effortMultiplier: Math.min(MAX_EFFORT_MULTIPLIER, Math.round(multiplier * 100) / 100),
    driver: parts.join(" "),
  };
}