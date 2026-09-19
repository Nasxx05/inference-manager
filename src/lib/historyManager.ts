import type { HistoryEntry } from "@/types";

const STORAGE_KEY = "promgent.history.v1";
const MAX_ENTRIES = 12;

export function readHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function writeHistory(entries: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable. History is non-essential.
  }
}

export function saveEntry(entry: HistoryEntry): HistoryEntry[] {
  const existing = readHistory().filter((e) => e.id !== entry.id);
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  writeHistory(next);
  return next;
}

export function clearHistory(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.taskName === "string" && typeof v.prompt === "string";
}