"use client";

import { ArrowLeft } from "lucide-react";
import type { ClarifyingQuestion } from "@/types";
import { Button, Field } from "./ui";

const INPUT_CLASS =
  "w-full rounded border border-line bg-white px-3 py-2.5 text-sm text-ink transition-colors " +
  "placeholder:text-[#A8ADA4] hover:border-[#CFCFC6] focus:border-forest";

export function ClarifyingQuestions({
  questions,
  answers,
  onChange,
  onBack,
  onSubmit,
  onSkip,
  busy,
  error,
}: {
  questions: ClarifyingQuestion[];
  answers: Record<string, string>;
  onChange: (id: string, value: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  onSkip: () => void;
  busy: boolean;
  error: string | null;
}) {
  const answeredCount = questions.filter((q) => (answers[q.id] ?? "").trim()).length;

  return (
    <div className="animate-fade-up">
      <div className="mx-auto max-w-[640px] text-center">
        <h1 className="text-2xl font-semibold leading-snug tracking-tight sm:text-[28px]">
          A few questions first
        </h1>
        <p className="mx-auto mt-3 max-w-[520px] text-sm leading-relaxed text-muted">
          Answer the ones that matter and the prompt will be built around them. Anything you leave
          blank falls back to a sensible default, so you can skip straight through.
        </p>
      </div>

      <div className="mx-auto mt-9 max-w-[820px] rounded border border-line bg-white p-5 sm:p-7">
        <div className="flex flex-col gap-6">
          {questions.map((question, index) => {
            const value = answers[question.id] ?? "";
            const filled = value.trim().length > 0;

            return (
              <div key={question.id} className="flex flex-col gap-2.5">
                <Field
                  label={`${index + 1}. ${question.question}`}
                  hint={question.hint}
                  htmlFor={`clarify-${question.id}`}
                >
                  <input
                    id={`clarify-${question.id}`}
                    type="text"
                    value={value}
                    placeholder={question.defaultValue}
                    onChange={(event) => onChange(question.id, event.target.value)}
                    className={INPUT_CLASS}
                  />
                </Field>

                {question.options?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {question.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() =>
                          onChange(question.id, value.trim() === option ? "" : option)
                        }
                        className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                          value.trim() === option
                            ? "border-forest bg-forest text-white"
                            : "border-line bg-white text-muted hover:border-[#CFCFC6] hover:text-ink"
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                ) : null}

                <p className="text-xs leading-relaxed text-muted">
                  {filled ? (
                    "Using your answer."
                  ) : (
                    <>
                      <span className="text-[#A8ADA4]">Skipped &middot; </span>
                      assumed: {question.defaultValue}
                    </>
                  )}
                </p>
              </div>
            );
          })}
        </div>

        {error ? (
          <p role="alert" className="mt-5 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <Button variant="ghost" onClick={onBack} disabled={busy}>
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
            Back
          </Button>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted">
              {answeredCount} of {questions.length} answered
            </span>
            <Button variant="secondary" onClick={onSkip} disabled={busy}>
              Skip and use defaults
            </Button>
            <Button onClick={onSubmit} disabled={busy}>
              {busy ? "Building prompt..." : "Build prompt"}
            </Button>
          </div>
        </div>

        {busy ? (
          <p aria-live="polite" className="mt-4 text-center text-xs text-muted">
            Compiling your prompt...
          </p>
        ) : null}
      </div>
    </div>
  );
}