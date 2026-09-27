import { endpoint } from "./backend";
import type {
  ArchitectureVersion,
  GuidedProjectSnapshot,
  InterviewSession,
  PlanningDepth,
  ProjectMemory,
  ProjectRecord,
  SrsDocument,
  ProjectReference,
  ProjectUsageSummary,
} from "@/types/project";
import type { PlanResult } from "@/types";
import type { IterationPrompt, ProjectIteration, SuggestionDiscussionMessage } from "@/types/iteration";

export interface GuidedUser { id: string; email?: string | null; }

export class GuidedApiError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "GuidedApiError";
    this.code = code;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint(path), {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: T; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !payload?.success) throw new GuidedApiError(payload?.error?.message ?? "The request could not be completed.", payload?.error?.code);
  return payload.data as T;
}

export function getSession(): Promise<{ user: GuidedUser }> {
  return call("/api/auth/session");
}

export function signIn(email: string, password: string): Promise<{ user: GuidedUser }> {
  return call("/api/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function signUp(email: string, password: string): Promise<{ authenticated: boolean; user: GuidedUser | null }> {
  return call("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function signOut(): Promise<void> {
  return call("/api/auth/signout", { method: "POST" });
}

export interface OrbioBalance { available: number; total?: number; used?: number; currency: string; source: "credits" | "key"; }

export type OrbioConnectionState = "unverified" | "active" | "invalid" | "disconnected";

export interface OrbioStatus { connected: boolean; keyFingerprint?: string; status: OrbioConnectionState; modelIds: string[]; balance: OrbioBalance | null; }

export function isUsableOrbioStatus(status: Pick<OrbioStatus, "connected" | "status">): boolean {
  return status.connected === true && status.status === "active";
}

export function getOrbioStatus(): Promise<OrbioStatus> {
  return call("/api/orbio/status");
}

export function connectOrbio(apiKey: string): Promise<OrbioStatus> {
  return call("/api/orbio/connect", { method: "POST", body: JSON.stringify({ apiKey }) });
}

export function disconnectOrbio(): Promise<{ connected: boolean }> {
  return call("/api/orbio/connect", { method: "DELETE" });
}

export function listProjects(): Promise<ProjectRecord[]> {
  return call("/api/projects");
}

export async function createProject(input: { description: string; modelId: string; planningDepth: PlanningDepth; budget: number; references?: Array<Pick<ProjectReference, "type" | "source" | "metadata">>; image?: File | null }): Promise<{ project: ProjectRecord; memory: ProjectMemory; interview: InterviewSession; assistantMessage: GuidedProjectSnapshot["messages"][number]; references?: ProjectReference[]; usage: ProjectUsageSummary }> {
  if (!input.image) return call("/api/projects", { method: "POST", body: JSON.stringify(input) });
  const form = new FormData();
  const { image, ...payload } = input;
  form.append("payload", JSON.stringify(payload));
  form.append("images", image, image.name);
  const response = await fetch(endpoint("/api/projects"), { method: "POST", credentials: "include", body: form });
  const result = (await response.json().catch(() => null)) as { success?: boolean; data?: { project: ProjectRecord; memory: ProjectMemory; interview: InterviewSession; assistantMessage: GuidedProjectSnapshot["messages"][number]; references?: ProjectReference[]; usage: ProjectUsageSummary }; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !result?.success || !result.data) throw new GuidedApiError(result?.error?.message ?? "The project could not be created.", result?.error?.code);
  return result.data;
}

export function generateProjectPlan(projectId: string): Promise<{ plan: PlanResult; projectId: string }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/plan`, { method: "POST" });
}

export function loadProject(projectId: string): Promise<GuidedProjectSnapshot> {
  return call(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function sendInterview(projectId: string, content: string, source: "text" | "voice_transcript" = "text") {
  return call<{ memory: ProjectMemory; session: InterviewSession; userMessage: GuidedProjectSnapshot["messages"][number]; assistantMessage: GuidedProjectSnapshot["messages"][number]; usage: ProjectUsageSummary }>(`/api/projects/${encodeURIComponent(projectId)}/interview`, { method: "POST", body: JSON.stringify({ content, source }) });
}

export function getProjectUsage(projectId: string): Promise<ProjectUsageSummary> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/usage`);
}

export function generateArchitecture(projectId: string): Promise<ArchitectureVersion> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/architecture`, { method: "POST" });
}

export function generateSrs(projectId: string): Promise<SrsDocument> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/srs`, { method: "POST" });
}

export function approveSrs(projectId: string, srsId: string): Promise<{ approvedSrsId: string }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/srs/${encodeURIComponent(srsId)}/approve`, { method: "POST" });
}

export function createIteration(projectId: string, title?: string): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations`, { method: "POST", body: JSON.stringify({ title }) });
}

export function listIterations(projectId: string): Promise<ProjectIteration[]> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations`);
}

export function loadIteration(projectId: string, iterationId: string): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}`);
}

export async function reviewIteration(projectId: string, iterationId: string, input: { repositoryUrl?: string; liveUrl?: string; text?: string; voiceTranscript?: string; forceReview?: boolean; screenshotFiles?: File[] }): Promise<ProjectIteration> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/review`;
  if (!input.screenshotFiles?.length) return call(path, { method: "POST", body: JSON.stringify(input) });
  const form = new FormData();
  const { screenshotFiles, ...payload } = input;
  form.append("payload", JSON.stringify(payload));
  screenshotFiles.slice(0, 4).forEach((file) => form.append("images", file, file.name));
  const response = await fetch(endpoint(path), { method: "POST", credentials: "include", body: form });
  const result = (await response.json().catch(() => null)) as { success?: boolean; data?: ProjectIteration; error?: { message?: string } } | null;
  if (!response.ok || !result?.success || !result.data) throw new Error(result?.error?.message ?? "The implementation review failed.");
  return result.data;
}

export function decideIterationSuggestion(projectId: string, iterationId: string, suggestionId: string, decision: "accept" | "reject" | "defer" | "discuss"): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/suggestions/${encodeURIComponent(suggestionId)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
}

export function getSuggestionDiscussion(projectId: string, iterationId: string, suggestionId: string): Promise<SuggestionDiscussionMessage[]> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/suggestions/${encodeURIComponent(suggestionId)}/discussion`);
}

export function sendSuggestionDiscussion(projectId: string, iterationId: string, suggestionId: string, content: string): Promise<{ iteration: ProjectIteration; messages: SuggestionDiscussionMessage[] }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/suggestions/${encodeURIComponent(suggestionId)}/discussion`, { method: "POST", body: JSON.stringify({ content }) });
}

export function decideIterationFinding(projectId: string, iterationId: string, findingId: string, decision: "accept" | "reject" | "defer"): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/findings/${encodeURIComponent(findingId)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
}

export function decideIterationChange(projectId: string, iterationId: string, changeId: string, decision: "accept" | "reject" | "defer"): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/changes/${encodeURIComponent(changeId)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
}

export function approveIterationChanges(projectId: string, iterationId: string): Promise<{ iteration: ProjectIteration; srs?: SrsDocument; architecture?: ArchitectureVersion }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/approve-changes`, { method: "POST" });
}

export function generateIterationPrompt(projectId: string, iterationId: string): Promise<{ iteration: ProjectIteration; prompt: IterationPrompt }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/generate-prompt`, { method: "POST" });
}

export function updateIterationStatus(projectId: string, iterationId: string, status: "implementation_in_progress" | "ready_for_rereview" | "completed"): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/status`, { method: "POST", body: JSON.stringify({ status }) });
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const response = await fetch(endpoint("/api/transcribe"), { method: "POST", credentials: "include", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
  const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: { text?: string }; error?: { message?: string } } | null;
  if (!response.ok || !payload?.success || !payload.data?.text) throw new Error(payload?.error?.message ?? "Voice transcription failed.");
  return payload.data.text;
}
