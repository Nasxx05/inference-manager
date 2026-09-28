import type { GuidedProjectSnapshot, SrsDocument } from "@/types/project";

export type ProjectWorkspaceMode = "interview" | "architecture" | "srs" | "implementation" | "iteration";

export function resolveProjectWorkspaceMode(snapshot: GuidedProjectSnapshot): ProjectWorkspaceMode {
  if (snapshot.implementationPlan) {
    return snapshot.project.status === "reviewing_repository" || snapshot.project.status === "iterating"
      ? "iteration"
      : "implementation";
  }
  if (snapshot.srs) return "srs";
  if (snapshot.architecture) return "architecture";
  return "interview";
}

export function canReviewImplementation(snapshot: GuidedProjectSnapshot | null): boolean {
  return Boolean(snapshot?.implementationPlan);
}

export function safeProjectReturnMode(input: {
  snapshot: GuidedProjectSnapshot;
  srs?: SrsDocument | null;
  hasImplementationPlan?: boolean;
}): Exclude<ProjectWorkspaceMode, "iteration"> {
  if (input.hasImplementationPlan ?? Boolean(input.snapshot.implementationPlan)) return "implementation";
  if (input.srs ?? input.snapshot.srs) return "srs";
  if (input.snapshot.architecture) return "architecture";
  return "interview";
}

export function canRenderProjectMode(input: {
  mode: ProjectWorkspaceMode;
  snapshot: GuidedProjectSnapshot | null;
  srs?: SrsDocument | null;
  hasImplementationPlan?: boolean;
}): boolean {
  if (!input.snapshot) return false;
  if (input.mode === "interview") return true;
  if (input.mode === "architecture") return Boolean(input.snapshot.architecture);
  if (input.mode === "srs") return Boolean(input.srs ?? input.snapshot.srs);
  if (input.mode === "implementation") return input.hasImplementationPlan ?? Boolean(input.snapshot.implementationPlan);
  return canReviewImplementation(input.snapshot);
}
