"use client";

import { AlertTriangle, Check, Minus } from "lucide-react";
import { TIER_LABEL, getModel } from "@/data/models";
import { explainCost, formatCredit, formatRange } from "@/lib/estimator/costEstimator";
import { resolveTaskEffort } from "@/lib/estimator/taskEffort";
import { buildEnrichedTask, majorWorkDrivers } from "@/lib/clarifier/enrichedTask";
import type { PlanResult } from "@/types";
import { Button, Card, Metric } from "./ui";

/**
 * Model suitability, shown separately from budget feasibility.
 *
 * A weak model and a small budget are different problems with different fixes,
 * so they are never merged into one verdict.
 */
function SuitabilityCard({
  plan,
  onSwitchModel,
  onKeepModel,
}: {
  plan: PlanResult;
  onSwitchModel: () => void;
  onKeepModel: () => void;
}) {
  const suitability = plan.suitability;
  if (!suitability) return null;

  const tone =
    suitability.status === "suitable"
      ? "border-forest/30 bg-forest-light text-forest"
      : suitability.status === "acceptable"
        ? "border-credit/30 bg-credit-light text-credit"
        : "border-danger-light bg-danger-light text-danger";

  const Icon =
    suitability.status === "suitable"
      ? Check
      : suitability.status === "acceptable"
        ? Minus
        : AlertTriangle;

  return (
    <Card title="Model Suitability">
      <div className={`rounded border px-3 py-2.5 ${tone}`}>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>{suitability.headline}</span>
        </div>
        {suitability.reasons.map((reason) => (
          <p key={reason} className="mt-1.5 text-xs leading-relaxed opacity-90">
            {reason}
          </p>
        ))}

        {suitability.capabilityGaps.length ? (
          <p className="mt-2 text-xs leading-relaxed opacity-90">
            Gaps: {suitability.capabilityGaps.join(", ")}.
          </p>
        ) : null}

        {suitability.suggestedModelName ? (
          <div className="mt-3 border-t border-current/20 pt-2.5">
            <p className="text-xs leading-relaxed opacity-90">
              Suggested: <span className="font-mono">{suitability.suggestedModelName}</span>
              {typeof suitability.suggestedDelta === "number"
                ? ` · ${suitability.suggestedDelta >= 0 ? "+" : ""}${formatCredit(suitability.suggestedDelta)} CREDIT`
                : ""}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onSwitchModel}>
                Switch Model
              </Button>
              <Button variant="ghost" onClick={onKeepModel}>
                Keep My Model
              </Button>
            </div>
          </div>
        ) : null}

        {suitability.overridden ? (
          <p className="mt-2.5 text-xs leading-relaxed opacity-90">
            You kept this model. The estimate below assumes reduced reliability and greater
            revision risk.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function StatusBadge({ plan }: { plan: PlanResult }) {
  const { status, headline, detail } = plan.feasibility;
  const styles = {
    fits: "border-forest/30 bg-forest-light text-forest",
    tight: "border-credit/30 bg-credit-light text-credit",
    "fits-with-optimization": "border-credit/30 bg-credit-light text-credit",
    "does-not-fit": "border-danger-light bg-danger-light text-danger",
  }[status];

  const Icon = status === "fits" ? Check : status === "does-not-fit" ? AlertTriangle : Minus;

  return (
    <div className={`rounded border px-3 py-2.5 ${styles}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{headline}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed opacity-90">{detail}</p>
    </div>
  );
}

/** Rounds tokens to readable figures — 24.3k, not 24,318. */
function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

export function AnalysisPanel({
  plan,
  onUseOptimizedScope,
  onKeepOriginalScope,
  onSwitchModel,
  onKeepModel,
  busy,
}: {
  plan: PlanResult;
  onUseOptimizedScope: () => void;
  onKeepOriginalScope: () => void;
  onSwitchModel: () => void;
  onKeepModel: () => void;
  busy: boolean;
}) {
  const model = getModel(plan.modelId);

  // Why the estimate is what it is, derived from real workload signals.
  const effort =
    plan.cost.effort ??
    resolveTaskEffort({ analysis: plan.analysis, taskDescription: plan.taskDescription });
  const drivers = explainCost(plan.analysis, effort);

  /**
   * Major work drivers: the resolved components and their weights.
   *
   * Derived from the same enriched task the estimator used, so this panel
   * cannot name a driver the estimate ignored.
   */
  const enriched = buildEnrichedTask({
    taskDescription: plan.taskDescription,
    taskType: plan.analysis.taskType,
    answers: plan.clarifyingAnswers ?? [],
  });
  const majorDrivers = majorWorkDrivers(enriched);

  return (
    <div className="flex flex-col gap-4">
      <Card title="Task Summary">
        <p className="text-sm leading-relaxed">{plan.analysis.summary}</p>
        <div className="mt-3 grid grid-cols-2 gap-x-4">
          <Metric label="Type" value={plan.analysis.taskType} mono={false} />
          <Metric label="Complexity" value={plan.analysis.complexity} mono={false} />
          <Metric label="Model" value={model?.displayName ?? plan.modelId} mono={false} />
          <Metric label="Iterations" value={plan.analysis.expectedIterations} />
          {effort ? (
            <>
              <Metric label="Effort" value={effort.level.replace("-", " ")} mono={false} />
              <Metric label="Requirements" value={effort.requirementCount} />
            </>
          ) : null}
          <Metric label="Confidence" value={plan.cost.confidence} mono={false} />
        </div>
      </Card>

      {/* The arithmetic behind the range, so the estimate is auditable. */}
      <Card title="Estimate Basis">
        <Metric label="Est. input tokens" value={formatTokens(plan.cost.estimatedInputTokens)} />
        <Metric label="Est. output tokens" value={formatTokens(plan.cost.estimatedOutputTokens)} />
        <Metric
          label="Est. inference cost"
          value={`${formatCredit(plan.cost.estimatedInferenceCost)} CREDIT`}
          tone="credit"
        />
        <Metric label="Modelled passes" value={plan.cost.modelledPasses} />
        <Metric label="Pricing" value={plan.cost.pricingSource} mono={false} />
      </Card>

      {/* WHY: makes a large estimate explainable rather than arbitrary. */}
      {drivers.length ? (
        <Card title="Why">
          <ul className="flex flex-col gap-1">
            {drivers.map((driver) => (
              <li key={driver} className="text-xs leading-relaxed text-muted">
                • {driver}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* The actual components driving the cost, with their workload weights. */}
      {majorDrivers.length > 0 ? (
        <Card title="Major Work Drivers">
          <ul className="flex flex-col gap-1.5">
            {majorDrivers.map((driver) => (
              <li
                key={driver.name}
                className="flex items-baseline justify-between gap-3 text-xs leading-relaxed"
              >
                <span>{driver.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-credit">
                  {driver.weight.replace("-", " ")}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <SuitabilityCard plan={plan} onSwitchModel={onSwitchModel} onKeepModel={onKeepModel} />

      <Card title="Budget">
        <Metric
          label="Planning budget"
          value={`${formatCredit(plan.budget)} CREDIT`}
          tone="credit"
        />
        {/* The floor: below this the core scope is unlikely to complete. */}
        <Metric
          label="Minimum viable"
          value={`${formatCredit(plan.cost.minimumViable)} CREDIT`}
          tone="credit"
        />
        <Metric
          label="Estimated cost"
          value={`${formatRange(plan.cost.minimum, plan.cost.maximum)} CREDIT`}
          tone="credit"
        />
        <Metric
          label="Recommended max"
          value={`${formatCredit(plan.cost.recommendedMaximum)} CREDIT`}
          tone="credit"
        />
        <Metric
          label="Reserve"
          value={`${formatCredit(plan.reserve.recommendedReserve)} CREDIT`}
          tone="credit"
        />
        <div className="mt-3 border-t border-line pt-3">
          <StatusBadge plan={plan} />
        </div>
        {/* Estimates are derived locally from curated pricing, so the UI must
            never imply a live provider quote. */}
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Planning estimate, not a guaranteed final provider bill. Actual cost depends on
          the model, token usage, iterations, tools and execution environment.
        </p>
      </Card>

      {plan.analysis.phases.length > 0 ? (
        <Card title="Phases">
          <ol className="flex flex-col gap-2.5">
            {plan.analysis.phases.map((phase) => (
              <li key={phase.name} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{phase.name}</p>
                  <p className="text-xs leading-relaxed text-muted">{phase.description}</p>
                </div>
                <span className="shrink-0 font-mono text-xs text-credit">
                  {formatRange(phase.estimatedCost[0], phase.estimatedCost[1])}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {plan.recommendation ? (
        <Card title="Recommended Model">
          <p className="text-sm font-medium">{plan.recommendation.displayName}</p>
          <Metric label="Estimated" value={`${formatCredit(plan.recommendation.estimated)} CREDIT`} tone="credit" />
          <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Why</p>
          <ul className="mt-1 flex flex-col gap-1">
            {plan.recommendation.reasons.map((reason) => (
              <li key={reason} className="text-xs leading-relaxed text-muted">
                • {reason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {plan.comparison.length > 0 ? (
        <Card title="Model Comparison">
          <ul className="flex flex-col gap-2">
            {plan.comparison.map((row) => (
              <li key={row.modelId} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {row.displayName}
                  <span className="ml-2 text-xs text-muted">{TIER_LABEL[row.capability]}</span>
                </span>
                <span className="shrink-0 font-mono text-xs text-credit">
                  {formatCredit(row.estimated)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line pt-2.5 text-xs leading-relaxed text-muted">
            Comparison is relative to this task, this budget and the selected optimization
            preference.
          </p>
        </Card>
      ) : null}

      {plan.optimizedScope ? (
        <Card title="Scope Optimization">
          <p className="text-xs leading-relaxed text-muted">{plan.optimizedScope.rationale}</p>

          {plan.optimizedScope.included.length > 0 ? (
            <div className="mt-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                Budget-compatible scope
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {plan.optimizedScope.included.map((item) => (
                  <li key={item} className="flex gap-2 text-xs leading-relaxed">
                    <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.optimizedScope.deferred.length > 0 ? (
            <div className="mt-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                Deferred
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {plan.optimizedScope.deferred.map((item) => (
                  <li key={item} className="flex gap-2 text-xs leading-relaxed text-muted">
                    <Minus aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.optimizedScope.simplified.length > 0 ? (
            <div className="mt-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                Simplifications
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {plan.optimizedScope.simplified.map((item) => (
                  <li key={item} className="text-xs leading-relaxed text-muted">
                    • {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {plan.scopeApplied ? (
              <p className="text-xs leading-relaxed text-forest">
                Optimized scope applied to this plan.
              </p>
            ) : (
              <>
                <Button onClick={onUseOptimizedScope} disabled={busy} className="flex-1">
                  Use Optimized Scope
                </Button>
                <Button
                  variant="secondary"
                  onClick={onKeepOriginalScope}
                  disabled={busy}
                  className="flex-1"
                >
                  Keep Original Scope
                </Button>
              </>
            )}
          </div>

          {!plan.scopeApplied && plan.feasibility.status === "does-not-fit" ? (
            <p className="mt-2 text-xs leading-relaxed text-danger">
              Keeping the original scope means the estimated cost stays above your budget.
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card title="Execution Plan">
        <p className="text-sm leading-relaxed">{plan.executionPlan.strategy}</p>
        <ol className="mt-3 flex flex-col gap-1.5">
          {plan.executionPlan.steps.map((step) => (
            <li key={step} className="text-xs leading-relaxed text-muted">
              {step}
            </li>
          ))}
        </ol>
      </Card>

      {plan.analysis.risks.length > 0 ? (
        <Card title="Risks">
          <ul className="flex flex-col gap-1.5">
            {plan.analysis.risks.map((risk) => (
              <li key={risk} className="flex gap-2 text-xs leading-relaxed text-muted">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{risk}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}