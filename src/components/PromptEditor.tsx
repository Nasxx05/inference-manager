"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import { getModel } from "@/data/models";
import { formatRange } from "@/lib/estimator/costEstimator";
import type { OptimizationPreference, PlanResult } from "@/types";
import { Button } from "./ui";

const REOPTIMIZE_LABELS: Record<OptimizationPreference, string> = {
  "minimize-cost": "Lower Cost",
  balanced: "Balanced",
  "maximum-quality": "Higher Quality",
};

export function PromptEditor({
  plan,
  onReoptimize,
  busy,
}: {
  plan: PlanResult;
  onReoptimize: (preference: OptimizationPreference) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan.prompt);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A new plan resets the editor state.
  useEffect(() => {
    setDraft(plan.prompt);
    setEditing(false);
    setCopied(false);
  }, [plan.id, plan.prompt]);

  async function copy() {
    const text = editing ? draft : plan.prompt;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const node = textareaRef.current;
        if (node) {
          node.select();
          document.execCommand("copy");
        }
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const model = getModel(plan.modelId);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Generated Prompt
          </h2>
          <p className="mt-1 font-mono text-xs text-muted">
            {model?.displayName ?? plan.modelId} · {formatRange(plan.cost.minimum, plan.cost.maximum)} CREDIT
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (editing) {
                setDraft(plan.prompt);
                setEditing(false);
              } else {
                setEditing(true);
                window.setTimeout(() => textareaRef.current?.focus(), 0);
              }
            }}
          >
            {editing ? (
              <>
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                Reset to Generated
              </>
            ) : (
              <>
                <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                Edit Prompt
              </>
            )}
          </Button>
          <Button onClick={copy}>
            {copied ? (
              <>
                <Check aria-hidden="true" className="h-3.5 w-3.5" />
                Prompt copied
              </>
            ) : (
              <>
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                Copy Prompt
              </>
            )}
          </Button>
        </div>
      </header>

      <textarea
        ref={textareaRef}
        value={editing ? draft : plan.prompt}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={!editing}
        spellCheck={false}
        aria-label="Generated prompt"
        className={`min-h-[420px] w-full flex-1 resize-y rounded border border-line bg-white p-4 font-mono text-[13px] leading-relaxed text-ink transition-colors ${
          editing ? "focus:border-forest" : "cursor-default"
        }`}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Re-optimize
          </span>
          {(Object.keys(REOPTIMIZE_LABELS) as OptimizationPreference[]).map((key) => (
            <button
              key={key}
              type="button"
              disabled={busy}
              onClick={() => onReoptimize(key)}
              aria-pressed={plan.optimization === key}
              className={`rounded border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                plan.optimization === key
                  ? "border-forest bg-forest-light text-forest"
                  : "border-line bg-white text-muted hover:border-[#CFCFC6] hover:text-ink"
              }`}
            >
              {REOPTIMIZE_LABELS[key]}
            </button>
          ))}
        </div>
        <p aria-live="polite" className="text-xs text-muted">
          {copied ? "Copied to clipboard" : ""}
        </p>
      </div>

      <p className="text-xs leading-relaxed text-muted">
        Read the prompt before you use it. AgentFund does not run this prompt — copy it and run it
        yourself in your preferred AI environment.
      </p>
    </div>
  );
}