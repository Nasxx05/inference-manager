"use client";

import { EXTERNAL_LINK_REL, HOW_TO_USE_VIDEO_EMBED_URL, HOW_TO_USE_VIDEO_WATCH_URL } from "@/lib/externalLinks";
import { Modal } from "./Modal";

/**
 * The walkthrough video is only mounted while the dialog is open, so nothing
 * from YouTube loads on a normal page visit.
 *
 * The youtube-nocookie host is used deliberately: it avoids setting tracking
 * cookies until the user actually plays the video.
 */

const STEPS = [
  "Describe the task, and optionally attach an image or paste a URL as a reference.",
  "Set a planning budget in CREDIT and pick an optimization preference.",
  "Review the plan, answer any clarifying questions, then copy the prompt into your own tool.",
];

export function HowToUseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} title="How to use Promgent" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="relative aspect-video w-full overflow-hidden rounded border border-line bg-canvas">
          <iframe
            className="absolute inset-0 h-full w-full"
            src={HOW_TO_USE_VIDEO_EMBED_URL}
            title="How to use Promgent"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>

        <ol className="flex flex-col gap-1.5">
          {STEPS.map((step, index) => (
            <li key={step} className="flex gap-2.5 text-[13px] leading-relaxed text-muted">
              <span className="mt-0.5 shrink-0 font-mono text-[11px] text-credit">
                {String(index + 1).padStart(2, "0")}
              </span>
              {step}
            </li>
          ))}
        </ol>

        <p className="text-xs text-muted">
          Prefer to watch it there?{" "}
          <a
            href={HOW_TO_USE_VIDEO_WATCH_URL}
            target="_blank"
            rel={EXTERNAL_LINK_REL}
            className="text-forest underline underline-offset-2 transition-colors hover:text-forest-dark"
          >
            Open on YouTube
          </a>
        </p>
      </div>
    </Modal>
  );
}