"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
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
import { TaskForm, type TaskFormValues } from "./TaskForm";
import { Button } from "./ui";
import { GeneratingScreen } from "./GeneratingScreen";

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
 */
type RunState = "idle" | "analyzing" | "success" | "error" | "cancelled";

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
        const response = await fetch(endpoint("/api/plan"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            taskDescription: merged.taskDescription,
            modelId: merged.modelId,
            optimization: merged.optimization,
            budget,
            applyOptimizedScope: overrides?.applyOptimizedScope === true,
            clarifyingQuestions: overrides?.clarifyingQuestions ?? [],
            clarifyingResponses: overrides?.clarifyingResponses ?? {},
          }),
        });

        const payload = (await response.json()) as {
          success: boolean;
          data?: PlanResult;
          error?: { code?: string; message?: string; requestId?: string };
        };

        const plan = payload.success ? payload.data : undefined;
        if (!response.ok || !plan) {
          // The backend returns a specific, human-readable message for every
          // failure mode (timeout, rate limit, unusable response). Only fall
          // back to a generic line if it is absent.
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
        setState((current) => (current === "cancelled" ? current : "idle"));
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
        // No usable questions: fall straight through to planning. Clarify is a
        // local computation, so planning surfaces any real model error.
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

  function handleNewTask() {
    setPlan(null);
    setError(null);
    setState("idle");
    setQuestions(null);
    setAnswers({});
    setClarifying(false);
    setValues({ ...INITIAL_VALUES, modelId: values.modelId, budget: values.budget });
  }

  const heading = useMemo(
    () =>
      plan
        ? "Execution plan and prompt"
        : "Know what your AI budget can accomplish before you spend it.",
    [plan],
  );

  const showClarifying = clarifying && questions !== null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-canvas">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-5 py-3.5">
          <span className="font-mono text-sm font-medium tracking-tight">Promgent</span>
          <div className="flex items-center gap-2">
            <HistoryPanel
              entries={history}
              onSelect={(entry) => {
                navigator.clipboard?.writeText(entry.prompt).catch(() => undefined);
              }}
            />
            {plan ? (
              <Button variant="secondary" onClick={handleNewTask}>
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                New Task
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-8 sm:py-12">
        {!plan ? (
          showClarifying ? (
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
                />
                {loading ? (
                  <GeneratingScreen
                    taskDescription={values.taskDescription}
                    onCancel={cancelGeneration}
                  />
                ) : null}
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
          )
        ) : (
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
                />
              </div>

              <div className="order-1 rounded border border-line bg-paper p-4 sm:p-5 lg:order-2">
                <PromptEditor plan={plan} onReoptimize={handleReoptimize} busy={loading} />
              </div>
            </div>

            {loading ? (
              <GeneratingScreen
                taskDescription={plan.taskDescription}
                onCancel={cancelGeneration}
              />
            ) : null}
            {state === "error" && error ? (
              <div role="alert" className="mt-4 text-center">
                <p className="text-sm font-medium text-danger">
                  We couldn't generate your prompt.
                </p>
                <p className="mt-1 text-sm text-muted">{error}</p>
              </div>
            ) : null}
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