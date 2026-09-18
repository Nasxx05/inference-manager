"use client";

import { ArrowLeft, Plus, X } from "lucide-react";
import type { ClarifyingQuestion } from "@/types";
import { Button, Field } from "./ui";

const INPUT_CLASS =
  "w-full rounded border border-line bg-white px-3 py-2.5 text-sm text-ink transition-colors " +
  "placeholder:text-[#A8ADA4] hover:border-[#CFCFC6] focus:border-forest";

const OPTION_SEPARATOR = ", ";

/** Splits a stored answer back into the individual options that were picked. */
export function parseSelections(value: string): string[] {
  return value
    .split(OPTION_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Returns the new answer with `option` toggled, preserving typed text. */
export function toggleSelection(
  current: string,
  option: string,
  singleSelect: boolean,
  options: string[] = [],
): string {
  const selected = parseSelections(current);
  const isOn = selected.includes(option);

  if (singleSelect) {
    // Mutually exclusive: drop any other option that was picked, keep text the
    // user typed themselves. Toggling the current choice off clears it.
    const typed = selected.filter((s) => !options.includes(s));
    return isOn ? typed.join(OPTION_SEPARATOR) : [option, ...typed].join(OPTION_SEPARATOR);
  }

  return isOn
    ? selected.filter((s) => s !== option).join(OPTION_SEPARATOR)
    : [...selected, option].join(OPTION_SEPARATOR);
}

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
  const totalSelections = questions.reduce(
    (acc, q) => acc + (q.options ? parseSelections(answers[q.id] ?? "").length : 0),
    0,
  );

  return (
    <div className="animate-fade-up">
      <div className="mx-auto max-w-[640px] text-center">
        <h1 className="text-2xl font-semibold leading-snug tracking-tight sm:text-[28px]">
          A few questions first
        </h1>
        <p className="mx-auto mt-3 max-w-[520px] text-sm leading-relaxed text-muted">
          Answer the ones that matter and the prompt will be built around them. Pick as many options
          as apply — or type your own. Anything left blank falls back to a sensible default, so you
          can skip straight through.
        </p>
      </div>

      <div className="mx-auto mt-9 max-w-[820px] rounded border border-line bg-white p-5 sm:p-7">
        <div className="flex flex-col gap-6">
          {questions.map((question, index) => {
            const value = answers[question.id] ?? "";
            const filled = value.trim().length > 0;
            const selected = parseSelections(value);
            const single = question.singleSelect === true;

            return (
              <div key={question.id} className="flex flex-col gap-2.5">
                <Field
                  label={`${index + 1}. ${question.question}`}
                  hint={question.hint}
                  htmlFor={`clarify-${question.id}`}
                >
                  <div className="relative">
                    <input
                      id={`clarify-${question.id}`}
                      type="text"
                      value={value}
                      placeholder={question.defaultValue}
                      onChange={(event) => onChange(question.id, event.target.value)}
                      className={`${INPUT_CLASS} pr-11`}
                    />
                    {filled ? (
                      <button
                        type="button"
                        onClick={() => onChange(question.id, "")}
                        aria-label={`Clear answer for: ${question.question}`}
                        title="Clear"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted transition-colors hover:bg-[#F3F3EF] hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-forest"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                </Field>

                {question.options?.length ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {question.options.map((option) => {
                      const isOn = selected.includes(option);
                      return (
                        <button
                          key={option}
                          type="button"
                          aria-pressed={isOn}
                          onClick={() =>
                            onChange(
                              question.id,
                              toggleSelection(value, option, single, question.options ?? []),
                            )
                          }
                          className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs transition-colors ${
                            isOn
                              ? "border-forest bg-forest text-white"
                              : "border-line bg-white text-muted hover:border-[#CFCFC6] hover:text-ink"
                          }`}
                        >
                          {isOn ? (
                            <X aria-hidden="true" className="h-3 w-3" />
                          ) : (
                            <Plus aria-hidden="true" className="h-3 w-3" />
                          )}
                          {option}
                        </button>
                      );
                    })}
                    {!single ? (
                      <span className="text-[11px] text-[#A8ADA4]">choose any that apply</span>
                    ) : null}
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
              {totalSelections > 0 ? ` · ${totalSelections} selected` : ""}
            </span>
            <Button variant="secondary" onClick={onSkip} disabled={busy}>
              Skip and use defaults
            </Button>
            <Button onClick={onSubmit} disabled={busy}>
              {busy ? "Writing your prompt..." : "Build prompt"}
            </Button>
          </div>
        </div>

        {busy ? (
          <p aria-live="polite" className="mt-4 text-center text-xs text-muted">
            This takes a couple of minutes — the model is writing your prompt.
          </p>
        ) : null}
      </div>
    </div>
  );
}