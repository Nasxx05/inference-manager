import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type {
  ArchitectureVersion,
  GuidedProjectSnapshot,
  InterviewMessage,
  InterviewSession,
  ProjectMemory,
  ProjectRecord,
  SrsDocument,
  ProjectReference,
  ProjectUsageSummary,
  AcceptanceCriterion,
} from "@/types/project";
import type { PlanResult } from "@/types";
import type { IterationPrompt, ProjectIteration, ScreenshotArtifact, SuggestionDiscussionMessage } from "@/types/iteration";
import { MODELS } from "@/data/models";
import { structuredAcceptanceCriteria } from "@/lib/projectMemory/proposals";

export interface AuthUser {
  id: string;
  email?: string;
}

export interface OrbioConnectionRecord {
  userId: string;
  encryptedKey: string;
  keyFingerprint: string;
  status: "unverified" | "active" | "invalid" | "disconnected";
  lastVerifiedAt?: string;
}

export class PersistenceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.status = status;
  }
}

function supabaseUrl(): string {
  return String(process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
}

function anonKey(): string {
  return String(process.env.SUPABASE_ANON_KEY ?? "").trim();
}

function serviceRoleKey(): string {
  return String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
}

export function persistenceConfigured(): boolean {
  return Boolean(supabaseUrl() && anonKey() && serviceRoleKey());
}

function requireConfigured(): void {
  if (!persistenceConfigured()) {
    throw new PersistenceError(
      "PERSISTENCE_NOT_CONFIGURED",
      "Persistent projects require SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
}

async function request<T>(input: {
  path: string;
  method?: string;
  body?: unknown;
  accessToken?: string;
  auth?: boolean;
}): Promise<T> {
  requireConfigured();
  const headers: Record<string, string> = {
    apikey: input.auth ? anonKey() : serviceRoleKey(),
    "Content-Type": "application/json",
  };
  if (input.method === "POST" && input.path.startsWith("/rest/v1/")) {
    headers.Prefer = "resolution=merge-duplicates,return=representation";
  }
  if (input.accessToken) headers.Authorization = `Bearer ${input.accessToken}`;
  const response = await fetch(`${supabaseUrl()}${input.path}`, {
    method: input.method ?? "GET",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "message" in payload
      ? String((payload as { message?: unknown }).message)
      : "The persistence service rejected the request.";
    throw new PersistenceError("PERSISTENCE_REQUEST_FAILED", message, response.status);
  }
  return payload as T;
}

export interface AuthResponse {
  access_token?: string;
  refresh_token?: string;
  user?: AuthUser;
}

export async function signUp(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>({
    path: "/auth/v1/signup",
    method: "POST",
    auth: true,
    body: { email, password },
  });
}

export async function signIn(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>({
    path: "/auth/v1/token?grant_type=password",
    method: "POST",
    auth: true,
    body: { email, password },
  });
}

export async function userForToken(accessToken: string): Promise<AuthUser> {
  return request<AuthUser>({ path: "/auth/v1/user", accessToken, auth: true });
}

function query(value: string): string {
  return encodeURIComponent(value);
}

export async function listProjects(userId: string): Promise<ProjectRecord[]> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/projects?select=*&user_id=eq.${query(userId)}&order=updated_at.desc`,
  });
  return rows.map(projectFromRow);
}

export async function insertProject(project: ProjectRecord): Promise<ProjectRecord> {
  const rows = await request<Record<string, unknown>[]>({
    path: "/rest/v1/projects?select=*",
    method: "POST",
    body: [projectToRow(project)],
  });
  const row = rows[0];
  if (!row) throw new PersistenceError("PERSISTENCE_REQUEST_FAILED", "The project was not created.");
  return projectFromRow(row);
}

export async function projectForUser(projectId: string, userId: string): Promise<ProjectRecord> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/projects?select=*&id=eq.${query(projectId)}&user_id=eq.${query(userId)}&limit=1`,
  });
  const row = rows[0];
  if (!row) throw new PersistenceError("PROJECT_NOT_FOUND", "That project was not found.", 404);
  return projectFromRow(row);
}

function connectionFromRow(row: Record<string, unknown>): OrbioConnectionRecord {
  return {
    userId: String(row.user_id ?? ""),
    encryptedKey: String(row.encrypted_key ?? ""),
    keyFingerprint: String(row.key_fingerprint ?? ""),
    status: String(row.status ?? "unverified") as OrbioConnectionRecord["status"],
    ...(row.last_verified_at ? { lastVerifiedAt: String(row.last_verified_at) } : {}),
  };
}

export async function readOrbioConnection(userId: string): Promise<OrbioConnectionRecord | null> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/orbio_connections?select=user_id,encrypted_key,key_fingerprint,status,last_verified_at&user_id=eq.${query(userId)}&limit=1`,
  });
  return rows[0] ? connectionFromRow(rows[0]) : null;
}

export async function saveOrbioConnection(input: OrbioConnectionRecord): Promise<OrbioConnectionRecord> {
  const rows = await request<Record<string, unknown>[]>({
    path: "/rest/v1/orbio_connections?on_conflict=user_id&select=user_id,encrypted_key,key_fingerprint,status,last_verified_at",
    method: "POST",
    body: [{
      user_id: input.userId,
      encrypted_key: input.encryptedKey,
      key_fingerprint: input.keyFingerprint,
      status: input.status,
      last_verified_at: input.lastVerifiedAt ?? null,
    }],
  });
  const saved = rows[0] ? connectionFromRow(rows[0]) : null;
  if (!saved || saved.userId !== input.userId || !saved.encryptedKey || saved.status !== input.status) {
    throw new PersistenceError("PERSISTENCE_REQUEST_FAILED", "The saved Orbio connection could not be confirmed.");
  }
  return saved;
}

export async function updateOrbioConnectionStatus(userId: string, status: OrbioConnectionRecord["status"], lastVerifiedAt?: string): Promise<void> {
  await request({
    path: `/rest/v1/orbio_connections?user_id=eq.${query(userId)}`,
    method: "PATCH",
    body: { status, ...(lastVerifiedAt ? { last_verified_at: lastVerifiedAt } : {}) },
  });
}

export async function deleteOrbioConnection(userId: string): Promise<void> {
  await request({ path: `/rest/v1/orbio_connections?user_id=eq.${query(userId)}`, method: "DELETE" });
}

/** Loads a connected Orbio credential only inside the backend process. */
export async function loadOrbioKey(userId: string): Promise<string> {
  const row = await readOrbioConnection(userId);
  if (!row) {
    throw new PersistenceError("ORBIO_NOT_CONNECTED", "Connect your Orbio account before starting a project.", 400);
  }
  if (row.status !== "active") {
    throw new PersistenceError("ORBIO_CONNECTION_INACTIVE", "Your saved Orbio connection is inactive. Reconnect it.", 400);
  }
  if (!row.encryptedKey) {
    throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
  }
  try {
    const decrypted = decryptOrbioKey(row.encryptedKey).trim();
    if (!decrypted) throw new Error("empty credential");
    return decrypted;
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED") throw error;
    throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
  }
}

export async function insertUsageEvent(input: {
  userId: string;
  projectId: string;
  phase: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  requestId?: string;
}): Promise<void> {
  await request({
    path: "/rest/v1/usage_events",
    method: "POST",
    body: [{
      user_id: input.userId,
      project_id: input.projectId,
      phase: input.phase,
      source: "promgent",
      model: input.model ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      cost: input.cost ?? null,
      request_id: input.requestId ?? null,
    }],
  });
}

function usageCost(row: Record<string, unknown>): { cost: number; estimated: boolean } {
  const recorded = Number(row.cost);
  if (Number.isFinite(recorded)) return { cost: Math.max(0, recorded), estimated: false };

  const inputTokens = Number(row.input_tokens);
  const outputTokens = Number(row.output_tokens);
  const modelId = String(row.model ?? "").trim();
  const model = MODELS.find((candidate) => candidate.id === modelId || candidate.providerModelId === modelId);
  if (!model || (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens))) {
    return { cost: 0, estimated: true };
  }

  const inputCost = Number.isFinite(inputTokens) ? (Math.max(0, inputTokens) / 1_000_000) * model.inputPrice : 0;
  const outputCost = Number.isFinite(outputTokens) ? (Math.max(0, outputTokens) / 1_000_000) * model.outputPrice : 0;
  return { cost: Number((inputCost + outputCost).toFixed(6)), estimated: true };
}

async function loadProjectUsage(projectId: string, userId: string, budget: number): Promise<ProjectUsageSummary> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/usage_events?select=phase,source,model,input_tokens,output_tokens,cost,created_at&project_id=eq.${query(projectId)}&user_id=eq.${query(userId)}&order=created_at.asc`,
  });
  const events = rows.map((row) => {
    const calculated = usageCost(row);
    return {
      phase: String(row.phase ?? "unknown"),
      source: row.source === "external_snapshot" ? "external_snapshot" as const : "promgent" as const,
      ...(row.model ? { model: String(row.model) } : {}),
      cost: calculated.cost,
      estimated: calculated.estimated,
      createdAt: String(row.created_at ?? new Date(0).toISOString()),
    };
  });
  const used = Number(events.reduce((total, event) => total + event.cost, 0).toFixed(6));
  const normalizedBudget = Math.max(0, Number(budget) || 0);
  return {
    budget: normalizedBudget,
    used,
    remaining: Number(Math.max(0, normalizedBudget - used).toFixed(6)),
    events,
    estimated: events.some((event) => event.estimated),
    updatedAt: new Date().toISOString(),
  };
}

export async function projectUsageForUser(projectId: string, userId: string): Promise<ProjectUsageSummary> {
  const project = await projectForUser(projectId, userId);
  return loadProjectUsage(project.id, userId, project.creditBudget);
}

export async function listIterations(projectId: string): Promise<ProjectIteration[]> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/project_iterations?select=*&project_id=eq.${query(projectId)}&order=sequence_number.asc`,
  });
  return rows.map(iterationFromRow);
}

export async function iterationForUser(iterationId: string, userId: string): Promise<ProjectIteration> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/project_iterations?select=*&id=eq.${query(iterationId)}&limit=1`,
  });
  const row = rows[0];
  if (!row) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
  await projectForUser(String(row.project_id), userId);
  return iterationFromRow(row);
}

export async function saveIteration(iteration: ProjectIteration): Promise<void> {
  await request({
    path: "/rest/v1/project_iterations?on_conflict=id",
    method: "POST",
    body: [{
      id: iteration.id,
      project_id: iteration.projectId,
      sequence_number: iteration.sequenceNumber,
      title: iteration.title,
      status: iteration.status,
      base_srs_version_id: iteration.baseSrsVersionId ?? null,
      base_architecture_version_id: iteration.baseArchitectureVersionId ?? null,
      reviewed_commit_sha: iteration.repositorySnapshot?.commitSha ?? null,
      data: iteration,
      started_at: iteration.startedAt,
      reviewed_at: iteration.reviewedAt ?? null,
      completed_at: iteration.completedAt ?? null,
      updated_at: iteration.updatedAt,
    }],
  });
}

export async function saveIterationPrompt(prompt: IterationPrompt): Promise<void> {
  await request({
    path: "/rest/v1/iteration_prompts?on_conflict=id",
    method: "POST",
    body: [{ id: prompt.id, iteration_id: prompt.iterationId, project_id: prompt.projectId, kind: prompt.kind, reviewed_commit_sha: prompt.reviewedCommitSha ?? null, prompt: prompt.prompt, data: prompt }],
  });
}

export async function saveSuggestionDiscussionMessage(message: SuggestionDiscussionMessage): Promise<void> {
  await request({ path: "/rest/v1/suggestion_discussions?on_conflict=id", method: "POST", body: [{ id: message.id, suggestion_id: message.suggestionId, iteration_id: message.iterationId, project_id: message.projectId, role: message.role, content: message.content, created_at: message.createdAt }] });
}

export async function saveScreenshotArtifacts(artifacts: ScreenshotArtifact[]): Promise<void> {
  if (!artifacts.length) return;
  await request({ path: "/rest/v1/screenshot_artifacts?on_conflict=id", method: "POST", body: artifacts.map((item) => ({ id: item.id, iteration_id: item.iterationId, project_id: item.projectId, filename: item.filename, mime_type: item.mimeType, analysis: item.analysis, created_at: item.createdAt })) });
}

export async function loadSuggestionDiscussion(suggestionId: string, projectId: string): Promise<SuggestionDiscussionMessage[]> {
  const rows = await request<Record<string, unknown>[]>({ path: `/rest/v1/suggestion_discussions?select=*&suggestion_id=eq.${query(suggestionId)}&project_id=eq.${query(projectId)}&order=created_at.asc` });
  return rows.map((row) => ({ id: String(row.id), suggestionId: String(row.suggestion_id), iterationId: String(row.iteration_id), projectId: String(row.project_id), role: row.role as "user" | "assistant", content: String(row.content), createdAt: String(row.created_at) }));
}

export async function loadLatestSrs(projectId: string): Promise<SrsDocument | undefined> {
  const rows = await request<Record<string, unknown>[]>({ path: `/rest/v1/srs_documents?select=*&project_id=eq.${query(projectId)}&order=version.desc&limit=1` });
  const row = rows[0];
  if (!row) return undefined;
  return { id: String(row.id), projectId: String(row.project_id), version: Number(row.version), title: String(row.title), content: String(row.content), requirementIds: Array.isArray(row.requirement_ids) ? row.requirement_ids.map(String) : [], status: row.status as SrsDocument["status"], createdAt: String(row.created_at) };
}

export async function loadLatestArchitecture(projectId: string): Promise<ArchitectureVersion | undefined> {
  const rows = await request<Record<string, unknown>[]>({ path: `/rest/v1/architecture_versions?select=*&project_id=eq.${query(projectId)}&order=version.desc&limit=1` });
  const row = rows[0];
  if (!row) return undefined;
  return { id: String(row.id), projectId: String(row.project_id), version: Number(row.version), diagramSource: String(row.diagram_source), summary: String(row.summary), reasonForChange: String(row.reason_for_change), createdAt: String(row.created_at) };
}

export async function insertInterviewSession(session: InterviewSession): Promise<void> {
  await request({
    path: "/rest/v1/interview_sessions",
    method: "POST",
    body: [sessionToRow(session)],
  });
}

export async function insertMessage(message: InterviewMessage): Promise<void> {
  await request({ path: "/rest/v1/interview_messages", method: "POST", body: [messageToRow(message)] });
}

export async function insertRequirements(projectId: string, requirements: ProjectMemory["requirements"]): Promise<void> {
  if (!requirements.length) return;
  await request({
    path: "/rest/v1/requirements?on_conflict=id",
    method: "POST",
    body: requirements.map((item) => requirementToRow(projectId, item)),
  });
}

export async function insertAcceptanceCriteria(projectId: string, criteria: AcceptanceCriterion[]): Promise<void> {
  if (!criteria.length) return;
  await request({
    path: "/rest/v1/acceptance_criteria?on_conflict=id",
    method: "POST",
    body: criteria.map((item) => ({ id: item.id, project_id: projectId, requirement_id: item.requirementId, description: item.description, source: item.source, source_message_id: item.sourceMessageId ?? null, status: item.status, confidence: item.confidence, version: item.version, created_at: item.createdAt, updated_at: item.updatedAt })),
  });
}

export async function saveMemory(memory: ProjectMemory): Promise<void> {
  await request({
    path: "/rest/v1/project_memory?on_conflict=project_id",
    method: "POST",
    body: [{ project_id: memory.projectId, memory, version: memory.version }],
  });
}

export async function loadMemory(projectId: string): Promise<ProjectMemory | null> {
  const rows = await request<Array<{ memory?: ProjectMemory }>>({
    path: `/rest/v1/project_memory?select=memory&project_id=eq.${query(projectId)}&limit=1`,
  });
  const memory = rows[0]?.memory ?? null;
  if (!memory) return null;
  return { ...memory, acceptanceCriteria: structuredAcceptanceCriteria(memory) };
}

export async function saveArchitecture(version: ArchitectureVersion): Promise<void> {
  await request({
    path: "/rest/v1/architecture_versions",
    method: "POST",
    body: [architectureToRow(version)],
  });
}

export async function saveSrs(document: SrsDocument): Promise<void> {
  await request({
    path: "/rest/v1/srs_documents",
    method: "POST",
    body: [srsToRow(document)],
  });
}

export async function saveProjectReferences(references: ProjectReference[]): Promise<void> {
  if (!references.length) return;
  await request({
    path: "/rest/v1/project_references?on_conflict=id",
    method: "POST",
    body: references.map((reference) => ({
      id: reference.id,
      project_id: reference.projectId,
      type: reference.type,
      source: reference.source,
      analysis: reference.analysis ?? {},
      metadata: reference.metadata,
      created_at: reference.createdAt,
    })),
  });
}

export async function loadProjectReferences(projectId: string): Promise<ProjectReference[]> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/project_references?select=*&project_id=eq.${query(projectId)}&order=created_at.asc`,
  });
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    type: row.type as ProjectReference["type"],
    source: String(row.source),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {},
    analysis: row.analysis && typeof row.analysis === "object" ? row.analysis as Record<string, unknown> : {},
    createdAt: String(row.created_at),
  }));
}

export async function saveProjectPlan(projectId: string, srsId: string, plan: PlanResult): Promise<void> {
  await request({
    path: "/rest/v1/generated_prompts",
    method: "POST",
    body: [{
      // PlanResult ids are UI/history ids, while this table's primary key is UUID.
      id: randomUUID(),
      project_id: projectId,
      srs_document_id: srsId,
      kind: "implementation",
      iteration: 1,
      prompt: plan.prompt,
      data: plan,
      created_at: plan.createdAt,
    }],
  });
}

export async function loadLatestProjectPlan(projectId: string): Promise<PlanResult | undefined> {
  const rows = await request<Record<string, unknown>[]>({
    path: `/rest/v1/generated_prompts?select=data&project_id=eq.${query(projectId)}&kind=eq.implementation&order=created_at.desc&limit=1`,
  });
  const data = rows[0]?.data;
  return data && typeof data === "object" ? data as PlanResult : undefined;
}

export async function approveSrs(projectId: string, srsId: string): Promise<void> {
  await request({
    path: `/rest/v1/srs_documents?id=eq.${query(srsId)}&project_id=eq.${query(projectId)}`,
    method: "PATCH",
    body: { status: "approved" },
  });
  await request({
    path: `/rest/v1/srs_documents?project_id=eq.${query(projectId)}&id=neq.${query(srsId)}`,
    method: "PATCH",
    body: { status: "superseded" },
  });
  await request({
    path: `/rest/v1/projects?id=eq.${query(projectId)}`,
    method: "PATCH",
    body: { approved_srs_version_id: srsId, status: "approved" },
  });
}

export async function saveProjectSession(session: InterviewSession): Promise<void> {
  await request({
    path: `/rest/v1/interview_sessions?id=eq.${query(session.id)}`,
    method: "PATCH",
    body: sessionToRow(session),
  });
}

export async function updateProjectStatus(projectId: string, status: ProjectRecord["status"]): Promise<void> {
  await request({ path: `/rest/v1/projects?id=eq.${query(projectId)}`, method: "PATCH", body: { status, updated_at: new Date().toISOString() } });
}

export async function snapshotForUser(projectId: string, userId: string): Promise<GuidedProjectSnapshot> {
  const project = await projectForUser(projectId, userId);
  const memory = await loadMemory(projectId);
  if (!memory) throw new PersistenceError("PROJECT_STATE_MISSING", "This project has no saved memory.", 500);
  const sessions = await request<Record<string, unknown>[]>({
    path: `/rest/v1/interview_sessions?select=*&project_id=eq.${query(projectId)}&order=created_at.desc&limit=1`,
  });
  const session = sessions[0] ? sessionFromRow(sessions[0]) : null;
  if (!session) throw new PersistenceError("PROJECT_STATE_MISSING", "This project has no interview session.", 500);
  const messages = await request<Record<string, unknown>[]>({
    path: `/rest/v1/interview_messages?select=*&project_id=eq.${query(projectId)}&order=created_at.asc`,
  });
  const [references, implementationPlan, architecture, srs, usage] = await Promise.all([
    loadProjectReferences(projectId),
    loadLatestProjectPlan(projectId),
    loadLatestArchitecture(projectId),
    loadLatestSrs(projectId),
    loadProjectUsage(projectId, userId, project.creditBudget),
  ]);
  return {
    project,
    memory,
    interview: session,
    messages: messages.map(messageFromRow),
    references,
    ...(implementationPlan ? { implementationPlan } : {}),
    ...(architecture ? { architecture } : {}),
    ...(srs ? { srs } : {}),
    usage,
  };
}

export function encryptOrbioKey(value: string): string {
  const configured = requireCredentialEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(configured, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptOrbioKey(value: string): string {
  const configured = requireCredentialEncryptionKey();
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(configured, "hex"), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
  }
}

export function credentialEncryptionConfigured(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(String(process.env.CREDENTIAL_ENCRYPTION_KEY ?? "").trim());
}

export function requireCredentialEncryptionKey(): string {
  const configured = String(process.env.CREDENTIAL_ENCRYPTION_KEY ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
    throw new PersistenceError("CREDENTIAL_ENCRYPTION_NOT_CONFIGURED", "CREDENTIAL_ENCRYPTION_KEY must be a stable 32-byte key encoded as 64 hexadecimal characters.", 503);
  }
  return configured;
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function projectToRow(project: ProjectRecord): Record<string, unknown> {
  return {
    id: project.id,
    user_id: project.userId,
    title: project.title,
    initial_description: project.initialDescription,
    project_type: project.projectType,
    selected_model: project.selectedModel,
    planning_depth: project.planningDepth,
    credit_budget: project.creditBudget,
    status: project.status,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    initialDescription: String(row.initial_description),
    projectType: String(row.project_type),
    selectedModel: String(row.selected_model),
    planningDepth: row.planning_depth as ProjectRecord["planningDepth"],
    creditBudget: Number(row.credit_budget),
    status: row.status as ProjectRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function iterationFromRow(row: Record<string, unknown>): ProjectIteration {
  const data = row.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as ProjectIteration;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sequenceNumber: Number(row.sequence_number),
    title: String(row.title),
    status: row.status as ProjectIteration["status"],
    ...(row.base_srs_version_id ? { baseSrsVersionId: String(row.base_srs_version_id) } : {}),
    ...(row.base_architecture_version_id ? { baseArchitectureVersionId: String(row.base_architecture_version_id) } : {}),
    changeRequests: [], findings: [], evidence: [], traceability: [], suggestions: [], decisions: [],
    startedAt: String(row.started_at), updatedAt: String(row.updated_at),
  };
}

function sessionToRow(session: InterviewSession): Record<string, unknown> {
  return {
    id: session.id,
    project_id: session.projectId,
    planning_depth: session.planningDepth,
    status: session.status,
    turn_count: session.turnCount,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function sessionFromRow(row: Record<string, unknown>): InterviewSession {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    planningDepth: row.planning_depth as InterviewSession["planningDepth"],
    status: row.status as InterviewSession["status"],
    turnCount: Number(row.turn_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function messageToRow(message: InterviewMessage): Record<string, unknown> {
  return { id: message.id, project_id: message.projectId, session_id: message.sessionId, role: message.role, content: message.content, source: message.source, created_at: message.createdAt };
}

function messageFromRow(row: Record<string, unknown>): InterviewMessage {
  return { id: String(row.id), projectId: String(row.project_id), sessionId: String(row.session_id), role: row.role as InterviewMessage["role"], content: String(row.content), source: row.source as InterviewMessage["source"], createdAt: String(row.created_at) };
}

function requirementToRow(projectId: string, item: ProjectMemory["requirements"][number]): Record<string, unknown> {
  return { id: item.id, project_id: projectId, type: item.type, category: item.category, description: item.description, priority: item.priority, required: item.required, source: item.source, source_message_id: item.sourceMessageId ?? null, status: item.status, confidence: item.confidence, dependencies: item.dependencies, version: item.version, created_at: item.createdAt, updated_at: item.updatedAt };
}

function architectureToRow(version: ArchitectureVersion): Record<string, unknown> {
  return { id: version.id, project_id: version.projectId, version: version.version, diagram_source: version.diagramSource, summary: version.summary, reason_for_change: version.reasonForChange, created_at: version.createdAt };
}

function srsToRow(document: SrsDocument): Record<string, unknown> {
  return { id: document.id, project_id: document.projectId, version: document.version, title: document.title, content: document.content, requirement_ids: document.requirementIds, status: document.status, created_at: document.createdAt };
}
