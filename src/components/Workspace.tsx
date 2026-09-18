"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { AUTO_MODEL_ID } from "@/data/models";
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

const INITIAL_VALUES: TaskFormValues = {
  taskDescription: "",
  modelId: AUTO_MODEL_ID,
  optimization: "balanced",
  budget: "10",
};

const LOADING_STEPS = [
  "Understanding task...",
  "Estimating scope...",
  "Checking budget...",
  "Preparing prompt...",
];

export function Workspace() {
  const [values, setValues] = useState<TaskFormValues>(INITIAL_VALUES);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [questions, setQuestions] = useState<ClarifyingQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [clarifying, setClarifying] = useState(false);

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => {
      setStep((s) => (s + 1) % LOADING_STEPS.length);
    }, 420);
    return () => window.clearInterval(timer);
  }, [loading]);

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
        return;
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        setError("Enter a valid CREDIT amount greater than zero.");
        return;
      }

      setError(null);
      setLoading(true);
      setStep(0);

      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

        const payload = (await response.json()) as { plan?: PlanResult; error?: string };

        if (!response.ok || !payload.plan) {
          setError(payload.error ?? "We couldn't analyze this task. Please try again.");
          return;
        }

        setPlan(payload.plan);
        setValues((v) => ({ ...v, optimization: merged.optimization }));
        setQuestions(null);
        setAnswers({});
        setClarifying(false);

        const entry: HistoryEntry = {
          id: payload.plan.id,
          taskName: planToHistoryName(payload.plan),
          modelId: payload.plan.modelId,
          budget: payload.plan.budget,
          estimatedCost: formatRange(payload.plan.cost.minimum, payload.plan.cost.maximum),
          optimization: payload.plan.optimization,
          prompt: payload.plan.prompt,
          timestamp: payload.plan.createdAt,
        };
        setHistory(saveEntry(entry));
      } catch {
        setError("We couldn't analyze this task. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [values],
  );

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskDescription: values.taskDescription.trim() }),
      });
      const payload = (await response.json()) as {
        questions?: ClarifyingQuestion[];
        error?: string;
      };

      if (!response.ok || !payload.questions || payload.questions.length === 0) {
        // No questions available: fall straight through to the old behaviour.
        void analyze();
        return;
      }

      setQuestions(payload.questions);
      setAnswers({});
      setClarifying(true);
    } catch {
      // Never block on the clarifying step.
      void analyze();
    } finally {
      setLoading(false);
    }
  }

  function handleReoptimize(preference: OptimizationPreference) {
    void analyze({ optimization: preference });
  }

  function handleNewTask() {
    setPlan(null);
    setError(null);
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
          <span className="font-mono text-sm font-medium tracking-tight">AgentFund</span>
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
                <h1 className="text-2xl font-semibold leading-snug tracking-tight sm:text-[28px]">
                  {heading}
                </h1>
                <p className="mx-auto mt-3 max-w-[520px] text-sm leading-relaxed text-muted">
                  Describe what you want to build, choose your model and budget, and AgentFund
                  creates a realistic execution plan and optimized prompt for the task.
                </p>
              </div>

              <div className="mx-auto mt-9 max-w-[820px] rounded border border-line bg-white p-5 sm:p-7">
                <TaskForm
                  values={values}
                  onChange={setValues}
                  onSubmit={handleSubmit}
                  loading={loading}
                  error={error}
                />
                {loading ? (
                  <p aria-live="polite" className="mt-4 text-center text-xs text-muted">
                    {LOADING_STEPS[step]}
                  </p>
                ) : null}
              </div>
            </div>
          )
        ) : (
          <div className="animate-fade-up">
            <div className="mb-6">
              <h1 className="text-lg font-semibold tracking-tight">Task analysis</h1>
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

              <div className="order-1 rounded border border-line bg-white p-4 sm:p-5 lg:order-2">
                <PromptEditor plan={plan} onReoptimize={handleReoptimize} busy={loading} />
              </div>
            </div>

            {loading ? (
              <p aria-live="polite" className="mt-4 text-center text-xs text-muted">
                {LOADING_STEPS[step]}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-4 text-center text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>
        )}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1180px] px-5 py-4">
          <p className="text-xs text-muted">
            AgentFund plans and compiles prompts only. It never executes your task, and it is not
            connected to any wallet or billing system.
          </p>
        </div>
      </footer>
    </div>
  );
}