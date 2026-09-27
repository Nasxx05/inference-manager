import { endpoint } from "./backend";
import type {
  ArchitectureVersion,
  GuidedProjectSnapshot,
  InterviewSession,
  PlanningDepth,
  ProjectMemory,
  ProjectRecord,
  SrsDocument,
} from "@/types/project";
import type { IterationPrompt, ProjectIteration } from "@/types/iteration";

export interface GuidedUser { id: string; email?: string | null; }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint(path), {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: T; error?: { message?: string } } | null;
  if (!response.ok || !payload?.success) throw new Error(payload?.error?.message ?? "The request could not be completed.");
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

export function getOrbioStatus(): Promise<{ connected: boolean; keyFingerprint?: string; status?: string }> {
  return call("/api/orbio/status");
}

export function connectOrbio(apiKey: string): Promise<{ connected: boolean; keyFingerprint: string }> {
  return call("/api/orbio/connect", { method: "POST", body: JSON.stringify({ apiKey }) });
}

export function disconnectOrbio(): Promise<{ connected: boolean }> {
  return call("/api/orbio/connect", { method: "DELETE" });
}

export function listProjects(): Promise<ProjectRecord[]> {
  return call("/api/projects");
}

export function createProject(input: { description: string; modelId: string; planningDepth: PlanningDepth; budget: number }): Promise<{ project: ProjectRecord; memory: ProjectMemory; interview: InterviewSession; assistantMessage: GuidedProjectSnapshot["messages"][number] }> {
  return call("/api/projects", { method: "POST", body: JSON.stringify(input) });
}

export function loadProject(projectId: string): Promise<GuidedProjectSnapshot> {
  return call(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function sendInterview(projectId: string, content: string, source: "text" | "voice_transcript" = "text") {
  return call<{ memory: ProjectMemory; session: InterviewSession; userMessage: GuidedProjectSnapshot["messages"][number]; assistantMessage: GuidedProjectSnapshot["messages"][number] }>(`/api/projects/${encodeURIComponent(projectId)}/interview`, { method: "POST", body: JSON.stringify({ content, source }) });
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

export function reviewIteration(projectId: string, iterationId: string, input: { repositoryUrl?: string; liveUrl?: string; text?: string; voiceTranscript?: string; screenshotIds?: string[] }): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/review`, { method: "POST", body: JSON.stringify(input) });
}

export function decideIterationSuggestion(projectId: string, iterationId: string, suggestionId: string, decision: "accept" | "reject" | "defer" | "discuss"): Promise<ProjectIteration> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(iterationId)}/suggestions/${encodeURIComponent(suggestionId)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
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
