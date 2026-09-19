"use client";

import { X } from "lucide-react";
import { AUTO_MODEL_ID, MODELS, TIER_LABEL } from "@/data/models";
import type { OptimizationPreference } from "@/types";
import { Button, Field, Select } from "./ui";

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

export function TaskForm({
  values,
  onChange,
  onSubmit,
  loading,
  error,
}: {
  values: TaskFormValues;
  onChange: (next: TaskFormValues) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
}) {
  function set<K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) {
    onChange({ ...values, [key]: value });
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
              "Build a responsive portfolio website using React and TypeScript with a projects section, contact form, dark mode, animations and mobile support."
            }
            className="w-full resize-y rounded border border-line bg-paper px-3.5 py-3 pr-11 text-[15px] leading-relaxed text-ink placeholder:text-muted transition-colors hover:border-lineStrong focus:border-forest"
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
        </div>
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

        <Field label="Available CREDIT" htmlFor="budget">
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