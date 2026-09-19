/**
 * The generation state shown while a plan is being produced.
 *
 * Replaces the previous blank/empty loading area. The animation is built from
 * plain elements with CSS keyframes — no image, no mascot, no new dependency.
 *
 * Two honesty rules this component enforces:
 *
 *  1. No fake progress. There is no percentage, because the backend does not
 *     report one. Only stage labels rotate, and they are worded as ongoing
 *     work ("Analyzing your request..."), never as completed milestones.
 *  2. No fake delays. The rotation interval exists only to keep the label
 *     moving; it does not gate, pace or artificially lengthen the request. The
 *     animation runs continuously for as long as the real request is in flight,
 *     and stopping early is fine.
 */

"use client";

import { useEffect, useState } from "react";

/** Labels describing ongoing work, never claimed completions. */
const STAGE_LABELS = [
  "Analyzing your request...",
  "Estimating the work...",
  "Optimizing for your model...",
  "Preparing your final prompt...",
] as const;

/** How long each label is shown. Long enough to read, not a progress signal. */
const LABEL_INTERVAL_MS = 2600;

/**
 * Derives a short project title from the task description.
 *
 * Deliberately local: spending an LLM call on a title would add latency to the
 * slow screen it is meant to decorate. It strips leading verbs and filler,
 * keeps at most four words, and falls back to "Your Project" when the text
 * yields nothing useful.
 */
export function projectTitle(taskDescription: string): string {
  const text = (taskDescription ?? "").trim();
  if (!text) return "Your Project";

  // First sentence only: anything after it is rarely part of the name.
  const firstSentence = text.split(/[.!?\n]/)[0]?.trim() || text;

  const words = firstSentence
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "Your Project";

  // Drop a leading instruction verb so "Build a responsive portfolio website"
  // becomes "Responsive Portfolio Website" rather than "Build A Responsive".
  const LEADING_VERBS = new Set([
    "build",
    "create",
    "make",
    "design",
    "develop",
    "write",
    "generate",
    "draft",
    "plan",
    "architect",
    "implement",
    "analyze",
    "analyse",
    "summarize",
    "summarise",
    "review",
    "help",
    "please",
    "i",
    "want",
    "need",
    "me",
    "a",
    "an",
    "the",
    "some",
  ]);

  const content = words.filter((w, index) => index > 0 || !LEADING_VERBS.has(w.toLowerCase()));
  const kept = (content.length ? content : words).slice(0, 4);

  const title = kept
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .trim();

  if (title.length < 3) return "Your Project";
  // Elide rather than wrap: a title must stay one short line.
  return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
}

export interface GeneratingScreenProps {
  taskDescription: string;
  onCancel?: () => void;
  /** False when the backend cannot be cancelled, so the control is not offered. */
  cancellable?: boolean;
}

export function GeneratingScreen({
  taskDescription,
  onCancel,
  cancellable = true,
}: GeneratingScreenProps) {
  const [labelIndex, setLabelIndex] = useState(0);
  const title = projectTitle(taskDescription);

  useEffect(() => {
    // Purely cosmetic rotation. It never affects the request itself, and the
    // request is never delayed to match it.
    const timer = setInterval(() => {
      setLabelIndex((index) => (index + 1) % STAGE_LABELS.length);
    }, LABEL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <section
      className="flex flex-col items-center justify-center gap-6 py-16 text-center"
      aria-live="polite"
      aria-busy="true"
    >
      {/* Four rounded elements moving vertically with a gentle stagger. The
          marks assemble and settle rather than spin, so it reads as work being
          put in order instead of a generic loading spinner. */}
      <div className="flex items-end gap-2" aria-hidden="true">
        <span className="pg-mark pg-mark-1" />
        <span className="pg-mark pg-mark-2" />
        <span className="pg-mark pg-mark-3" />
        <span className="pg-mark pg-mark-4" />
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Generating your prompt</h2>
        <p className="text-sm font-medium text-[var(--muted)]">{title}</p>
        <p className="text-sm text-[var(--muted)]">{STAGE_LABELS[labelIndex]}</p>
      </div>

      {cancellable && onCancel ? (
        <button type="button" onClick={onCancel} className="text-sm text-[var(--muted)] underline">
          Cancel
        </button>
      ) : null}
    </section>
  );
}