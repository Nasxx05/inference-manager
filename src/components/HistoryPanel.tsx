"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { HistoryEntry } from "@/types";

export function HistoryPanel({
  entries,
  onSelect,
}: {
  entries: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
}) {
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="recent-list"
        className="inline-flex items-center gap-1.5 rounded border border-line bg-white px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-[#CFCFC6] hover:text-ink"
      >
        Recent
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <ul
          id="recent-list"
          className="absolute right-0 z-20 mt-1.5 w-64 overflow-hidden rounded border border-line bg-white"
        >
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(entry);
                  setOpen(false);
                }}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-[#FCFCFA]"
              >
                <span className="min-w-0 truncate text-xs">{entry.taskName}</span>
                <span className="shrink-0 font-mono text-[11px] text-credit">
                  {entry.budget} CREDIT
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}