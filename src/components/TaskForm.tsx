"use client";

import { useRef } from "react";
import { ImageIcon, Plus, X } from "lucide-react";
import { AUTO_MODEL_ID, MODELS, TIER_LABEL } from "@/data/models";
import type { OptimizationPreference } from "@/types";
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_EXTENSIONS } from "@/lib/reference/types";
import { Button, Field, Select } from "./ui";

/** An image the user attached, held only until they submit or remove it. */
export interface Attachment {
  id: string;
  file: File;
  name: string;
  /** Object URL for the thumbnail. Revoked when the attachment is removed. */
  previewUrl: string;
}

export interface TaskFormValues {
  taskDescription: string;
  modelId: string;
  optimization: OptimizationPreference;
  budget: string;
}

const OPTIMIZATION_HINTS: Record<OptimizationPreference, string> = {
  "minimize-cost": "Prioritizes cheaper execution strategies and a tighter scope.",
  balanced: "Prioritizes a strong result while preserving enough budget for revisions and validation.",
  "maximum-quality":
    "Prefers stronger models, more validation, and greater execution headroom when the budget allows it.",
};

const OPTIMIZATION_LABELS: Record<OptimizationPreference, string> = {
  "minimize-cost": "Minimize Cost",
  balanced: "Balanced",
  "maximum-quality": "Maximum Quality",
};

const MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

/**
 * Frontend validation is a convenience only — the backend re-validates against
 * the file's actual bytes. This exists so the user finds out immediately.
 */
export function validateAttachment(file: File): string | null {
  const lower = file.name.toLowerCase();
  const extOk = SUPPORTED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
  if (!extOk) {
    return "Only PNG, JPG and WEBP images are supported.";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `Images must be ${MB}MB or smaller.`;
  }
  if (file.size === 0) {
    return "That image is empty.";
  }
  return null;
}

export function TaskForm({
  values,
  onChange,
  onSubmit,
  loading,
  error,
  attachments,
  onAddAttachment,
  onRemoveAttachment,
  attachmentError,
}: {
  values: TaskFormValues;
  onChange: (next: TaskFormValues) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
  attachments: Attachment[];
  onAddAttachment: (file: File) => void;
  onRemoveAttachment: (id: string) => void;
  attachmentError: string | null;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);

  function set<K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file fires another change event.
    event.target.value = "";
    if (file) onAddAttachment(file);
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <Field label="What do you want to accomplish?" htmlFor="task">
        <div className="relative">
          <textarea
            id="task"
            value={values.taskDescription}
            onChange={(e) => set("taskDescription", e.target.value)}
            rows={6}
            aria-describedby={error ? "task-error" : undefined}
            aria-invalid={error ? true : undefined}
            placeholder={
              "Build a responsive portfolio website using React and TypeScript with a projects section, contact form, dark mode, animations and mobile support. Paste a website URL or attach an image to use as a reference."
            }
            className="w-full resize-y rounded border border-line bg-paper px-3.5 py-3 pr-11 pb-11 text-[15px] leading-relaxed text-ink placeholder:text-muted transition-colors hover:border-lineStrong focus:border-forest"
          />
          {values.taskDescription.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                set("taskDescription", "");
                document.getElementById("task")?.focus();
              }}
              aria-label="Clear task description"
              title="Clear"
              className="absolute right-2.5 top-2.5 rounded p-1.5 text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-forest"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}

          {/* Attachment control, inside the input area rather than a separate
              section: references belong with the task they describe. */}
          <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex items-end justify-between gap-2">
            <p className="pointer-events-none font-mono text-[11px] text-muted">
              {attachments.length
                ? `${attachments.length} image reference${attachments.length === 1 ? "" : "s"} attached`
                : "URL or image optional"}
            </p>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label="Attach an image reference"
              title="Attach an image reference (PNG, JPG, WEBP)"
              className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded border border-line bg-paper text-muted transition-colors hover:border-lineStrong hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-forest"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          onChange={handleFile}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />

        {/* Attached previews sit immediately under the input, so the user can
            see and remove what they are about to send. */}
        {attachments.length ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {attachments.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded border border-line bg-canvas px-2 py-1.5"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.previewUrl}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded object-cover"
                />
                <span className="max-w-[180px] truncate text-[13px] text-ink">{item.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(item.id)}
                  aria-label={`Remove ${item.name}`}
                  title="Remove"
                  className="rounded p-1 text-muted transition-colors hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-forest"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {attachmentError ? (
          <p role="alert" className="mt-2 text-[13px] text-danger">
            {attachmentError}
          </p>
        ) : null}

        {!attachments.length && !attachmentError ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
            <ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />
            Optional: paste a website URL, or attach an image for Promgent to use as a design
            reference.
          </p>
        ) : null}
      </Field>

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Target Model" htmlFor="model">
          <Select
            id="model"
            value={values.modelId}
            onChange={(e) => set("modelId", e.target.value)}
          >
            <option value={AUTO_MODEL_ID}>Auto-select</option>
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName} · {TIER_LABEL[model.capabilityTier]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Optimization Preference"
          htmlFor="optimization"
          hint={OPTIMIZATION_HINTS[values.optimization]}
        >
          <Select
            id="optimization"
            value={values.optimization}
            onChange={(e) => set("optimization", e.target.value as OptimizationPreference)}
          >
            {(Object.keys(OPTIMIZATION_LABELS) as OptimizationPreference[]).map((key) => (
              <option key={key} value={key}>
                {OPTIMIZATION_LABELS[key]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Planning Budget"
          hint="The inference budget you plan to spend. Not a wallet balance."
          htmlFor="budget"
        >
          <div className="relative">
            <input
              id="budget"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.5"
              value={values.budget}
              onChange={(e) => set("budget", e.target.value)}
              className="w-full rounded border border-line bg-paper px-3 py-2.5 pr-20 font-mono text-sm text-ink transition-colors hover:border-lineStrong focus:border-forest"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-credit">
              CREDIT
            </span>
          </div>
        </Field>
      </div>

      {error ? (
        <p
          id="task-error"
          role="alert"
          className="rounded border border-danger-light bg-danger-light px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="flex justify-center">
        <Button type="submit" disabled={loading} className="w-full sm:w-auto sm:min-w-[220px]">
          {loading ? "Analyzing..." : "Analyze Task"}
        </Button>
      </div>

      <p className="text-center text-xs text-muted">
        Promgent plans and compiles. It never runs your task.
      </p>
    </form>
  );
}