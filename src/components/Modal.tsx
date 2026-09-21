"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * A minimal accessible dialog.
 *
 * Rendered inline rather than through a portal: the workspace header is the
 * only caller, so a portal would add machinery without solving a real problem.
 * It still traps focus, closes on Escape, closes on backdrop click, and
 * restores focus to the trigger when it closes.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  /**
   * The live callback, read through a ref.
   *
   * Callers pass an inline arrow, so depending on `onClose` directly would
   * re-subscribe the key handler on every render — and each re-subscribe runs
   * the cleanup, which would hand focus back to the trigger while the dialog
   * is still open.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Capture the trigger once, before focus moves into the panel.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const focusables = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => !el.hasAttribute("disabled"));

    focusables()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      // Keep focus inside the dialog while it is open.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    // Prevent the page behind the dialog from scrolling.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onClick={() => closeRef.current()}
    >
      <div className="absolute inset-0 bg-ink/40" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[720px] animate-fade-up rounded border border-line bg-paper"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label="Close"
            title="Close"
            className="rounded p-1.5 text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-forest"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}