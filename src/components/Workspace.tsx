"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { AUTO_MODEL_ID } from "@/data/models";
import { endpoint } from "@/lib/backend";
import { readHistory, saveEntry } from "@/lib/historyManager";
import { planToHistoryName } from "@/lib/promptCompiler/promptCompiler";
import { formatRange } from "@/lib/estimator/costEstimator";
import type {
  ClarifyingQuestion,
  HistoryEntry,
  OptimizationPreference,
  PlanResult,
} from "@/types";
import { AnalysisPanel } from "./AnalysisPanel";
import { ClarifyingQuestions } from "./ClarifyingQuestions";
import { HistoryPanel } from "./HistoryPanel";
import { PromptEditor } from "./PromptEditor";
import { TaskForm, validateAttachment, type Attachment, type TaskFormValues } from "./TaskForm";
import { Button } from "./ui";
import { GeneratingScreen } from "./GeneratingScreen";

/** Builds a multipart body only when there is an image to attach. */
function formDataFor(
  fields: Record<string, string>,
  attachments: Attachment[],
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const item of attachments) form.append("images", item.file, item.name);
  return form;
}

const INITIAL_VALUES: TaskFormValues = {
  taskDescription: "",
  modelId: AUTO_MODEL_ID,
  optimization: "balanced",
  budget: "10",
};

/**
 * Explicit UI states.
 *
 * "cancelled" is deliberately distinct from "idle": both show the form, but
 * cancelling is the user's own action, so it must not be reported as an error
 * and must not leave the Analyze button disabled.
 *
 * "editing" means the user returned to the composer from a result. Inputs stay
 * populated; the previous plan is retained but not shown as current.
 */
type RunState =
  | "idle"
  | "analyzing"
  | "success"
  | "error"
  | "cancelled"
  | "editing";

export function Workspace() {
  const [values, setValues] = useState<TaskFormValues>(INITIAL_VALUES);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [state, setState] = useState<RunState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  /**
   * The in-flight request.
   *
   * Serves two purposes: Cancel can genuinely abort the request rather than
   * merely hiding the animation while an expensive LLM call continues, and its
   * presence is the duplicate-submission guard.
   */
  const inFlight = useRef<AbortController | null>(null);

  const loading = state === "analyzing";

  /**
   * Attached image references. Held only in component state: they are sent
   * with the request, used for one analysis, and never stored anywhere.
   */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const addAttachment = useCallback((file: File) => {
    const problem = validateAttachment(file);
    if (problem) {
      setAttachmentError(problem);
      return;
    }
    setAttachmentError(null);
    setAttachments((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
      },
    ]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      // Release the object URL so a removed attachment does not leak memory.
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
    setAttachmentError(null);
  }, []);

  const [questions, setQuestions] = useState<ClarifyingQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [clarifying, setClarifying] = useState(false);

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  useEffect(() => {
    // Abort only on real unmount. A cancellation clears the ref itself.
    return () => inFlight.current?.abort();
  }, []);

  const cancelGeneration = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setState("cancelled");
    setError(null);
  }, []);

  const validate = useCallback((): string | null => {
    if (!values.taskDescription.trim()) {
      return "Describe what you want to accomplish before continuing.";
    }
    const budget = Number(values.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      return "Enter a valid CREDIT amount greater than zero.";
    }
    return null;
  }, [values]);

  const analyze = useCallback(
    async (
      overrides?: Partial<TaskFormValues> & {
        applyOptimizedScope?: boolean;
        clarifyingQuestions?: ClarifyingQuestion[];
        clarifyingResponses?: Record<string, string>;
      },
    ) => {
      const merged = { ...values, ...overrides };
      const budget = Number(merged.budget);

      if (!merged.taskDescription.trim()) {
        setError("Describe what you want to accomplish before continuing.");
        setState("error");
        return;
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        setError("Enter a valid CREDIT amount greater than zero.");
        setState("error");
        return;
      }

      // Duplicate-submission guard. The button is disabled too, but this
      // protects the state itself, so a double click or a rapid Enter can never
      // start two expensive LLM calls.
      if (inFlight.current) return;

      setError(null);
      setState("analyzing");

      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const fields = {
          taskDescription: merged.taskDescription,
          modelId: merged.modelId,
          optimization: merged.optimization,
          budget: String(budget),
          applyOptimizedScope: overrides?.applyOptimizedScope === true ? "true" : "false",
          clarifyingQuestions: JSON.stringify(overrides?.clarifyingQuestions ?? []),
          clarifyingResponses: JSON.stringify(overrides?.clarifyingResponses ?? {}),
        };

        /**
         * JSON unless an image is attached.
         *
         * Text-only requests keep the exact request shape they always had —
         * multipart is only used when there is genuinely a file to send.
         */
        const hasImages = attachments.length > 0;
        const body = hasImages ? formDataFor(fields, attachments) : JSON.stringify(fields);

        const response = await fetch(endpoint("/api/plan"), {
          method: "POST",
          ...(hasImages ? {} : { headers: { "Content-Type": "application/json" } }),
          signal: controller.signal,
          body,
        });

        const payload = (await response.json()) as {
          success: boolean;
          data?: PlanResult;
          error?: { code?: string; message?: string; requestId?: string };
        };

        const plan = payload.success ? payload.data : undefined;
        if (!response.ok || !plan) {
          setError(
            payload.error?.message ?? "We couldn't generate your prompt. Please try again.",
          );
          setState("error");
          return;
        }

        setPlan(plan);
        setState("success");
        setValues((v) => ({ ...v, optimization: merged.optimization }));
        setQuestions(null);
        setAnswers({});
        setClarifying(false);

        const entry: HistoryEntry = {
          id: plan.id,
          taskName: planToHistoryName(plan),
          modelId: plan.modelId,
          budget: plan.budget,
          estimatedCost: formatRange(plan.cost.minimum, plan.cost.maximum),
          optimization: plan.optimization,
          prompt: plan.prompt,
          timestamp: plan.createdAt,
        };
        setHistory(saveEntry(entry));
      } catch (caught) {
        // An abort is the user's own action, not a failure.
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError("We couldn't generate your prompt. Please try again.");
        setState("error");
      } finally {
        inFlight.current = null;
        // Never overwrite a cancellation with a derived state.
        setState((current) =>
          current === "cancelled" || current === "success" ? current : "idle",
        );
      }
    },
    [values],
  );

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      setState("error");
      return;
    }

    setError(null);
    setState("idle");

    try {
      const response = await fetch(endpoint("/api/clarify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskDescription: values.taskDescription.trim() }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: { questions?: ClarifyingQuestion[] };
        error?: { code?: string; message?: string };
      };

      const questions = payload.success ? payload.data?.questions : undefined;
      if (!response.ok || !questions || questions.length === 0) {
        // No usable questions: go straight to planning.
        void analyze();
        return;
      }

      setQuestions(questions);
      setAnswers({});
      setClarifying(true);
    } catch {
      // Never block on the clarifying step.
      void analyze();
    }
  }

  function handleReoptimize(preference: OptimizationPreference) {
    void analyze({ optimization: preference });
  }

  /**
   * Returns to the composer without discarding anything: task, model, quality,
   * budget and clarifying answers all stay populated, so the user can change
   * one field and re-run instead of starting over.
   */
  function handleEditTask() {
    setError(null);
    setState("editing");
  }

  function handleNewTask() {
    setPlan(null);
    setError(null);
    setAttachmentError(null);
    // Release every preview URL before dropping the attachments.
    setAttachments((current) => {
      for (const item of current) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
    setState("idle");
    setQuestions(null);
    setAnswers({});
    setClarifying(false);
    setValues({ ...INITIAL_VALUES, modelId: values.modelId, budget: values.budget });
  }

  const handleSelectHistory = useCallback((entry: HistoryEntry) => {
    // Restore the prompt for a previous task without re-running the model.
    navigator.clipboard?.writeText(entry.prompt).catch(() => undefined);
  }, []);

  const handlePromptChange = useCallback((prompt: string) => {
    setPlan((current) => (current ? { ...current, prompt } : current));
  }, []);

  const heading = useMemo(
    () =>
      plan
        ? "Execution plan and prompt"
        : "Know what your AI budget can accomplish before you spend it.",
    [plan],
  );

  const showClarifying = clarifying && questions !== null;
  const editing = state === "editing";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex items-center gap-3">
            {/* Edit Task stays visible without scrolling, on mobile too. */}
            {plan ? (
              <button
                type="button"
                onClick={handleEditTask}
                className="inline-flex items-center gap-1.5 rounded text-[13px] text-muted transition-colors hover:text-ink"
              >
                <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                Edit Task
              </button>
            ) : null}
            <span className="font-mono text-sm font-medium tracking-tight">Promgent</span>
          </div>

          <div className="flex items-center gap-2">
            <HistoryPanel
              entries={history}
              onSelect={(entry) => {
                navigator.clipboard?.writeText(entry.prompt).catch(() => undefined);
              }}
            />
            {plan ? (
              <>
                {/* Re-analyze runs the full pipeline again with edited values. */}
                <Button variant="secondary" onClick={() => void handleSubmit()}>
                  Re-analyze Task
                </Button>
                <Button variant="secondary" onClick={handleNewTask}>
                  <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  New Task
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-8 sm:py-12">
        {state === "analyzing" ? (
          <GeneratingScreen
            taskDescription={values.taskDescription}
            onCancel={cancelGeneration}
          />
        ) : showClarifying ? (
          <ClarifyingQuestions
            questions={questions}
            answers={answers}
            onChange={(id, value) => setAnswers((a) => ({ ...a, [id]: value }))}
            onBack={() => {
              setClarifying(false);
              setQuestions(null);
              setAnswers({});
              setError(null);
              setState("idle");
            }}
            onSubmit={() =>
              void analyze({
                clarifyingQuestions: questions,
                clarifyingResponses: answers,
              })
            }
            onSkip={() => void analyze({ clarifyingQuestions: questions })}
            busy={loading}
            error={error}
          />
        ) : editing ? (
          /* Editing: the composer, with every previous value still populated. */
          <div className="animate-fade-up">
            <div className="mx-auto max-w-[640px] text-center">
              <h1 className="display text-[30px] leading-snug text-ink sm:text-[36px]">
                {heading}
              </h1>
              <p className="mx-auto mt-3 max-w-[520px] text-sm leading-relaxed text-muted">
                Adjust any field and re-analyze. Your previous answers are preserved.
              </p>
            </div>

            <div className="mx-auto mt-9 max-w-[820px] rounded border border-line bg-paper p-5 sm:p-7">
              <TaskForm
                values={values}
                onChange={setValues}
                onSubmit={() => void handleSubmit()}
                loading={loading}
                error={error}
                attachments={attachments}
                onAddAttachment={addAttachment}
                onRemoveAttachment={removeAttachment}
                attachmentError={attachmentError}
              />
              <div className="mt-6 flex flex-wrap gap-3">
                <Button onClick={() => void handleSubmit()} disabled={loading}>
                  Re-analyze Task
                </Button>
                {plan ? (
                  <Button variant="secondary" onClick={() => setState("success")}>
                    Back to results
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : plan ? (
          <div className="animate-fade-up">
            <div className="mb-6">
              <h1 className="display text-[24px] text-ink">Task analysis</h1>
              <p className="mt-1 text-sm text-muted">
                {plan.autoSelected
                  ? "Model auto-selected for this task and budget."
                  : "Prompt optimized for your selected model."}
              </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start">
              <div className="order-2 lg:order-1">
                <AnalysisPanel
                  plan={plan}
                  busy={loading}
                  onUseOptimizedScope={() => void analyze({ applyOptimizedScope: true })}
                  onKeepOriginalScope={() => {
                    setPlan((p) => (p ? { ...p, optimizedScope: null } : p));
                  }}
                  onSwitchModel={() => {
                    const suggested = plan.suitability?.suggestedModelId;
                    if (!suggested) return;
                    // Switch to the suggested model and re-run the analysis.
                    setValues((v) => ({ ...v, modelId: suggested }));
                    void analyze({ modelId: suggested });
                  }}
                  onKeepModel={() => {
                    // Record the override so the UI can state the trade-off.
                    setPlan((p) =>
                      p && p.suitability
                        ? { ...p, suitability: { ...p.suitability, overridden: true } }
                        : p,
                    );
                  }}
                />
              </div>

              <div className="order-1 rounded border border-line bg-paper p-4 sm:p-5 lg:order-2">
                <PromptEditor plan={plan} onReoptimize={handleReoptimize} busy={loading} />
              </div>
            </div>

            {state === "error" && error ? (
              <div role="alert" className="mt-4 text-center">
                <p className="text-sm font-medium text-danger">
                  We couldn't generate your prompt.
                </p>
                <p className="mt-1 text-sm text-muted">{error}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="animate-fade-up">
            <div className="mx-auto max-w-[640px] text-center">
              {/* Editorial serif on the primary heading: the type carries the
                  personality, so weight stays light and spacing stays calm. */}
              <h1 className="display text-[30px] leading-snug text-ink sm:text-[36px]">
                {heading}
              </h1>
              <p className="mx-auto mt-3 max-w-[520px] text-sm leading-relaxed text-muted">
                Describe what you want to build, choose your model and budget, and Promgent
                creates a realistic execution plan and optimized prompt for the task.
              </p>
            </div>

            <div className="mx-auto mt-9 max-w-[820px] rounded border border-line bg-paper p-5 sm:p-7">
              <TaskForm
                values={values}
                onChange={setValues}
                onSubmit={handleSubmit}
                loading={loading}
                error={error}
                attachments={attachments}
                onAddAttachment={addAttachment}
                onRemoveAttachment={removeAttachment}
                attachmentError={attachmentError}
              />
              {state === "error" && error ? (
                <div role="alert" className="mt-4 text-center">
                  <p className="text-sm font-medium text-danger">
                    We couldn't generate your prompt.
                  </p>
                  <p className="mt-1 text-sm text-muted">{error}</p>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1180px] px-5 py-4">
          <p className="text-xs text-muted">
            Promgent plans and compiles prompts only. It never executes your task, and it is not
            connected to any wallet or billing system.
          </p>
        </div>
      </footer>
    </div>
  );
}