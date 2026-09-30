import { heuristicAnalyze } from "@/lib/ai/taskAnalyzer";
import { getModel } from "@/data/models";
import { estimateCost } from "./costEstimator";
import { selectModel } from "@/lib/models/modelSelector";
import type { ProjectMemory, ProjectRecord } from "@/types/project";

export interface ImplementationCreditEstimate {
  kind: "implementation_estimate";
  modelProfile: string;
  planning: { minimum: number; maximum: number };
  initialBuild: { minimum: number; maximum: number };
  testingDebugging: { minimum: number; maximum: number };
  revisionReserve: { minimum: number; maximum: number };
  total: { minimum: number; maximum: number };
  estimated: true;
  note: string;
}

function round(value: number): number { return Math.round(value * 100) / 100; }
function range(total: { minimum: number; maximum: number }, minShare: number, maxShare: number) { return { minimum: round(total.minimum * minShare), maximum: round(total.maximum * maxShare) }; }

/** Deterministic external coding-agent estimate; never records Promgent usage. */
export function estimateProjectImplementationCredit(project: ProjectRecord, memory: ProjectMemory): ImplementationCreditEstimate {
  const description = [memory.purpose, ...memory.requirements.filter((item) => item.status !== "rejected" && item.status !== "superseded").map((item) => item.description)].join("\n");
  const analysis = heuristicAnalyze(description);
  const recommended = selectModel(analysis, project.creditBudget, "balanced", description);
  const locked = project.modelMode === "locked" ? getModel(project.selectedModel) : undefined;
  const model = locked ?? getModel(recommended.modelId);
  if (!model) throw new Error("No curated implementation model profile is available.");
  const total = estimateCost({ analysis, model, preference: "balanced", taskDescription: description });
  const normalized = { minimum: round(total.minimum), maximum: round(total.maximum) };
  return {
    kind: "implementation_estimate", modelProfile: model.id,
    planning: range(normalized, 0.06, 0.08), initialBuild: range(normalized, 0.58, 0.65),
    testingDebugging: range(normalized, 0.16, 0.20), revisionReserve: range(normalized, 0.20, 0.25),
    total: normalized, estimated: true,
    note: "Estimated CREDIT for work in an external coding agent. This is separate from Promgent's actual usage.",
  };
}

export function implementationEstimateMarkdown(estimate: ImplementationCreditEstimate): string {
  const show = (value: { minimum: number; maximum: number }) => `${value.minimum.toFixed(2)}–${value.maximum.toFixed(2)} CREDIT`;
  return [`# Estimated build budget`, ``, `Planning: ${show(estimate.planning)}`, `Initial build: ${show(estimate.initialBuild)}`, `Testing and debugging: ${show(estimate.testingDebugging)}`, `Revision reserve: ${show(estimate.revisionReserve)}`, ``, `Estimated total: ${show(estimate.total)}`, ``, estimate.note].join("\n");
}
