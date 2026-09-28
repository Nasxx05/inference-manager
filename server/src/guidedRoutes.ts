import { randomUUID } from "node:crypto";
import express from "express";
import { AiError } from "@/lib/ai/errors";
import {
  applyInterviewTurn,
  architectureForMemory,
  createInitialMemory,
  createProjectRecord,
  generateSrs,
  structuredAcceptanceCriteria,
  validateInterviewProposal,
  calculateCompleteness,
  refreshQuestionBacklog,
  detectContradictions,
} from "@/lib/projectMemory";
import type { InterviewSession, PlanningDepth } from "@/types/project";
import {
  AuthUser,
  PersistenceError,
  approveSrs,
  insertInterviewSession,
  insertMessage,
  insertProject,
  insertRequirements,
  insertAcceptanceCriteria,
  insertUsageEvent,
  listProjects,
  loadMemory,
  persistenceConfigured,
  projectForUser,
  projectUsageForUser,
  saveArchitecture,
  saveMemory,
  saveProjectSession,
  saveSrs,
  signIn,
  signUp,
  snapshotForUser,
  iterationForUser,
  listIterations,
  loadLatestArchitecture,
  loadLatestSrs,
  saveIteration,
  saveIterationPrompt,
  saveSuggestionDiscussionMessage,
  loadSuggestionDiscussion,
  saveScreenshotArtifacts,
  saveProjectPlan,
  saveProjectReferences,
  updateProjectStatus,
  userForToken,
} from "./persistence";
import { providerModelId, runGuidedInterviewInference } from "./guidedInterview";
import { inspectLiveProduct, inspectRepository } from "./iterationEvidence";
import { runChangeImpactInference, runIterationPromptInference, runIterationReviewInference, runSuggestionDiscussionInference, runSuggestionScopeInference } from "./iterationAgent";
import { connectOrbioConnection, disconnectOrbioConnection, getOrbioConnectionStatus, getVerifiedOrbioConnection } from "./orbioConnectionService";
import { TranscriptionError, transcribeAudio } from "./transcription";
import { buildTraceability, createIteration, extractChangeRequests, findingsFromTraceability, generateIterationPrompt, suggestionsForProject, summarizeIteration, technicalFindings } from "@/lib/iteration";
import type { ProjectIteration, ProjectSuggestion } from "@/types/iteration";
import type { ProjectReference } from "@/types/project";
import { buildPlanWithMetrics } from "@/lib/planner";
import { planningRequestFromApprovedSrs } from "@/lib/projectMemory/plannerAdapter";
import { processReferences, referenceError } from "@/lib/reference";
import type { ReferenceAnalysis, ReferenceInput } from "@/lib/reference/types";
import { MultipartError, parseMultipart } from "./multipart";

const SESSION_COOKIE = "promgent_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

function cookies(request: express.Request): Record<string, string> {
  const header = String(request.headers.cookie ?? "");
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [];
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    return key ? [[key, decodeURIComponent(value)] as [string, string]] : [];
  }));
}

function setSession(response: express.Response, token: string): void {
  const production = process.env.NODE_ENV === "production";
  const attributes = production ? "; Secure; SameSite=None" : "; SameSite=Lax";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly${attributes}`);
}

function clearSession(response: express.Response): void {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

async function authenticatedUser(request: express.Request): Promise<AuthUser> {
  const token = cookies(request)[SESSION_COOKIE];
  if (!token) throw new PersistenceError("AUTH_REQUIRED", "Sign in to use Promgent projects.", 401);
  try {
    return await userForToken(token);
  } catch {
    throw new PersistenceError("AUTH_REQUIRED", "Your session has expired. Please sign in again.", 401);
  }
}

function body(request: express.Request): Record<string, unknown> {
  return request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
}

function errorResponse(response: express.Response, error: unknown): void {
  if (error instanceof PersistenceError) {
    response.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof AiError) {
    const status = error.code === "AI_AUTH_FAILED" ? 401
      : error.code === "AI_MODEL_UNAVAILABLE" || error.code === "AI_VALIDATION_FAILED" ? 400
        : error.code === "AI_TIMEOUT" || error.code === "AI_RATE_LIMITED" || error.code === "AI_PROVIDER_UNREACHABLE" ? 503
          : 502;
    const message = error.code === "AI_AUTH_FAILED"
      ? "Orbio rejected the connected key. Reconnect it before continuing."
      : error.code === "AI_MODEL_UNAVAILABLE"
        ? "The selected model is not available through the connected Orbio account."
        : error.code === "AI_TIMEOUT"
          ? "Orbio took too long to answer. Please try this interview turn again."
          : error.code === "AI_RATE_LIMITED"
            ? "Orbio is rate limiting this account. Please wait and try again."
            : "Orbio could not complete this interview turn. Please try again.";
    response.status(status).json({ success: false, error: { code: error.code, message, requestId: error.requestId } });
    return;
  }
  console.error("[guided-project] unexpected error", error instanceof Error ? error.message : "unknown");
  response.status(500).json({ success: false, error: { code: "PROJECT_OPERATION_FAILED", message: "The project operation failed." } });
}

function validDepth(value: unknown): PlanningDepth {
  return value === "fast" || value === "thorough" ? value : "balanced";
}

function referencesFromInput(projectId: string, value: unknown, now: string): ProjectReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item): ProjectReference[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const type = raw.type === "image" || raw.type === "website" || raw.type === "file" ? raw.type : null;
    const source = String(raw.source ?? "").trim().slice(0, 4000);
    if (!type || !source) return [];
    return [{
      id: randomUUID(),
      projectId,
      type,
      source,
      metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata as Record<string, unknown> : {},
      analysis: { status: "pending", note: "Reference attached at intake; analysis is tracked on the project." },
      createdAt: now,
    }];
  });
}

function projectRequestInput(request: express.Request): { input: Record<string, unknown>; images: Array<{ buffer: Buffer; mimeType?: string; filename?: string }> } {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().includes("multipart/form-data")) return { input: body(request), images: [] };
  if (!Buffer.isBuffer(request.body)) throw new PersistenceError("REFERENCE_ANALYSIS_FAILED", "The image upload could not be read.", 400);
  try {
    const parsed = parseMultipart(request.body, contentType);
    const input = JSON.parse(parsed.fields.payload ?? "{}") as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid payload");
    return { input: input as Record<string, unknown>, images: parsed.files.filter((file) => file.fieldname === "images").map((file) => ({ buffer: file.buffer, mimeType: file.mimetype, filename: file.originalname })) };
  } catch (error) {
    if (error instanceof MultipartError) throw new PersistenceError(error.code, error.message, 400);
    throw new PersistenceError("PROJECT_VALIDATION_FAILED", "The project intake payload was malformed.", 400);
  }
}

function projectReferencesFromAnalysis(projectId: string, inputs: ReferenceInput[], analyses: ReferenceAnalysis[], now: string): ProjectReference[] {
  return analyses.map((analysis, index) => {
    const reference = inputs[index];
    const source = reference?.type === "website" ? reference.url : reference?.type === "image" ? `upload:${reference.filename ?? `image-${index + 1}`}` : `reference:${index + 1}`;
    const metadata = reference?.type === "image" ? { filename: reference.filename, mimeType: reference.mimeType, validatedBytes: Buffer.from(reference.base64, "base64").length } : { inspectedUrl: source, visualInspection: analysis.visual };
    return { id: randomUUID(), projectId, type: analysis.type, source, metadata, analysis: analysis as unknown as Record<string, unknown>, createdAt: now };
  });
}

async function processSelectedModelReferences(input: Parameters<typeof processReferences>[0]) {
  try { return await processReferences(input); }
  catch (error) {
    if (input.images?.length && error instanceof AiError) throw new PersistenceError("MODEL_VISION_UNAVAILABLE", "The selected project model could not analyze the supplied image. Choose a vision-capable Orbio model; Promgent will not silently switch models.", 400);
    throw error;
  }
}

async function recordGuidedUsage(input: {
  userId: string;
  projectId: string;
  phase?: string;
  model: string;
  requestId: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}): Promise<void> {
  try {
    await insertUsageEvent({
      userId: input.userId,
      projectId: input.projectId,
      phase: input.phase ?? "requirements_interview",
      model: input.model,
      requestId: input.requestId,
      inputTokens: input.usage?.inputTokens,
      outputTokens: input.usage?.outputTokens,
    });
  } catch (error) {
    // The provider has already charged the user's key. Do not make the browser
    // retry the turn and risk another charge just because ledger persistence
    // is temporarily unavailable.
    console.error("[guided-project] usage ledger write failed", error instanceof Error ? error.message : "unknown");
  }
}

export function guidedRouter(): express.Router {
  const router = express.Router();

  router.get("/config", (_request, response) => {
    response.json({ success: true, data: { persistenceConfigured: persistenceConfigured() } });
  });

  router.post("/transcribe", async (request, response) => {
    try {
      await authenticatedUser(request);
      const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const text = await transcribeAudio({ buffer, mimeType: String(request.headers["content-type"] ?? "audio/webm") });
      response.json({ success: true, data: { text } });
    } catch (error) {
      if (error instanceof TranscriptionError) response.status(error.status).json({ success: false, error: { code: error.code, message: error.message, requestId: error.requestId } });
      else errorResponse(response, error);
    }
  });

  router.post("/auth/signup", async (request, response) => {
    try {
      const input = body(request);
      const email = String(input.email ?? "").trim();
      const password = String(input.password ?? "");
      if (!email || password.length < 8) throw new PersistenceError("AUTH_VALIDATION_FAILED", "Use a valid email and a password of at least 8 characters.", 400);
      const result = await signUp(email, password);
      if (result.access_token) setSession(response, result.access_token);
      response.status(201).json({ success: true, data: { authenticated: Boolean(result.access_token), user: result.user ? { id: result.user.id, email: result.user.email } : null } });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/auth/signin", async (request, response) => {
    try {
      const input = body(request);
      const result = await signIn(String(input.email ?? "").trim(), String(input.password ?? ""));
      if (!result.access_token) throw new PersistenceError("AUTH_FAILED", "Sign in requires email confirmation or returned no session.", 401);
      setSession(response, result.access_token);
      response.json({ success: true, data: { user: result.user ? { id: result.user.id, email: result.user.email } : null } });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/auth/signout", (_request, response) => {
    clearSession(response);
    response.json({ success: true });
  });

  router.get("/auth/session", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      response.json({ success: true, data: { user: { id: user.id, email: user.email ?? null } } });
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "AUTH_REQUIRED") {
        response.status(401).json({ success: false, error: { code: error.code, message: error.message } });
      } else errorResponse(response, error);
    }
  });

  router.get("/orbio/status", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      response.json({ success: true, data: await getOrbioConnectionStatus(user.id) });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/orbio/connect", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const key = String(body(request).apiKey ?? "").trim();
      const connection = await connectOrbioConnection(user.id, key);
      response.json({ success: true, data: { connected: true, status: "active", keyFingerprint: connection.fingerprint, modelIds: connection.modelIds, balance: connection.balance } });
    } catch (error) { errorResponse(response, error); }
  });

  router.delete("/orbio/connect", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      await disconnectOrbioConnection(user.id);
      response.json({ success: true, data: { connected: false, status: "disconnected", modelIds: [], balance: null } });
    } catch (error) { errorResponse(response, error); }
  });

  router.get("/projects", async (request, response) => {
    try { response.json({ success: true, data: await listProjects((await authenticatedUser(request)).id) }); }
    catch (error) { errorResponse(response, error); }
  });

  router.post("/projects", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const parsedRequest = projectRequestInput(request);
      const input = parsedRequest.input;
      const description = String(input.description ?? "").trim();
      const budget = Number(input.budget);
      const modelId = String(input.modelId ?? "auto").trim() || "auto";
      if (!description || description.length > 8000 || !Number.isFinite(budget) || budget <= 0) {
        throw new PersistenceError("PROJECT_VALIDATION_FAILED", "Provide a task description and a valid CREDIT budget.", 400);
      }
      // Resolve once per request, then reuse this exact persisted credential
      // for reference analysis and the opening Requirements Agent call.
      const connection = await getVerifiedOrbioConnection(user.id);
      const project = {
        ...createProjectRecord({ userId: user.id, id: randomUUID(), description, modelId, planningDepth: validDepth(input.planningDepth), budget }),
        status: "interviewing" as const,
      };
      let memory = createInitialMemory(project);
      const declaredReferences = Array.isArray(input.references) ? input.references : [];
      const urls = declaredReferences.flatMap((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "website" ? [String((item as { source?: unknown }).source ?? "").trim()] : []).filter(Boolean);
      const referenceRequestId = randomUUID();
      const referenceResult = await processSelectedModelReferences({ taskDescription: description, images: parsedRequest.images, urls, requestId: referenceRequestId, provider: { apiKey: connection.apiKey, baseUrl: String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "").trim().replace(/\/+$/, ""), model: providerModelId(project.selectedModel) } });
      if (!referenceResult.ok) throw referenceError(referenceResult.code, referenceResult.message);
      const analyzedReferences = projectReferencesFromAnalysis(project.id, referenceResult.references, referenceResult.analyses, project.createdAt);
      const legacyReferences = referenceResult.references.length ? [] : referencesFromInput(project.id, input.references, project.createdAt);
      const references = [...analyzedReferences, ...legacyReferences];
      if (referenceResult.analyses.length) memory = { ...memory, designPreferences: [...new Set([...memory.designPreferences, ...referenceResult.analyses.map((analysis) => `Reference observation (${analysis.type}, ${analysis.visual ? "visual" : "structure only"}): ${analysis.summary}`)])], version: memory.version + 1, updatedAt: project.createdAt };
      const session: InterviewSession = { id: randomUUID(), projectId: project.id, planningDepth: project.planningDepth, status: "active", nextQuestion: memory.openQuestions[0], turnCount: 0, createdAt: project.createdAt, updatedAt: project.updatedAt };
      const inference = await runGuidedInterviewInference({ apiKey: connection.apiKey, project, memory, opening: true });
      const intakeProposal = validateInterviewProposal({ raw: inference.structuredProposal, memory, userContent: description, sourceMessageId: `intake:${project.id}`, now: project.createdAt });
      const intakeDraft = { ...memory, requirements: intakeProposal.requirements, acceptanceCriteria: intakeProposal.acceptanceCriteria, users: [...new Set([...memory.users, ...intakeProposal.users])], assumptions: [...new Set([...memory.assumptions, ...intakeProposal.assumptions])], designPreferences: [...new Set([...memory.designPreferences, ...intakeProposal.designPreferences])], technicalConstraints: [...new Set([...memory.technicalConstraints, ...intakeProposal.technicalConstraints])], version: memory.version + 1, updatedAt: project.createdAt };
      const intakeConflicts = detectContradictions(intakeDraft);
      const intakeWithConflicts = { ...intakeDraft, conflicts: intakeConflicts };
      memory = { ...intakeWithConflicts, openQuestions: refreshQuestionBacklog(intakeWithConflicts), completeness: calculateCompleteness(intakeWithConflicts, project.planningDepth) };
      session.nextQuestion = memory.openQuestions[0];
      const assistantMessage = {
        id: randomUUID(),
        projectId: project.id,
        sessionId: session.id,
        role: "assistant" as const,
        content: inference.assistantContent,
        source: "system" as const,
        createdAt: project.createdAt,
      };
      await insertProject(project);
      await saveMemory(memory);
      await insertRequirements(project.id, memory.requirements);
      await insertAcceptanceCriteria(project.id, structuredAcceptanceCriteria(memory));
      await saveProjectReferences(references);
      await insertInterviewSession(session);
      await insertMessage(assistantMessage);
      await recordGuidedUsage({ userId: user.id, projectId: project.id, model: inference.model, requestId: inference.requestId, usage: inference.usage });
      if (referenceResult.analyses.length) await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "reference_analysis", model: providerModelId(project.selectedModel), requestId: referenceRequestId });
      response.status(201).json({ success: true, data: { project, memory, interview: session, assistantMessage, references, usage: await projectUsageForUser(project.id, user.id) } });
    } catch (error) { errorResponse(response, error); }
  });

  router.get("/projects/:projectId", async (request, response) => {
    try { response.json({ success: true, data: await snapshotForUser(request.params.projectId, (await authenticatedUser(request)).id) }); }
    catch (error) { errorResponse(response, error); }
  });

  router.get("/projects/:projectId/usage", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      response.json({ success: true, data: await projectUsageForUser(request.params.projectId, user.id) });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/interview", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const snapshot = await snapshotForUser(request.params.projectId, user.id);
      const content = String(body(request).content ?? "").trim();
      if (!content || content.length > 8000) throw new PersistenceError("INTERVIEW_VALIDATION_FAILED", "Enter a response before sending it.", 400);
      const inference = await runGuidedInterviewInference({ apiKey: (await getVerifiedOrbioConnection(user.id)).apiKey, project: snapshot.project, memory: snapshot.memory, userContent: content });
      const result = applyInterviewTurn({ memory: snapshot.memory, session: snapshot.interview, content, source: body(request).source === "voice_transcript" ? "voice_transcript" : "text", assistantContent: inference.assistantContent, structuredProposal: inference.structuredProposal });
      await insertMessage(result.userMessage);
      await insertMessage(result.assistantMessage);
      await saveMemory(result.memory);
      await insertRequirements(snapshot.project.id, result.memory.requirements);
      await insertAcceptanceCriteria(snapshot.project.id, structuredAcceptanceCriteria(result.memory));
      await saveProjectSession(result.session);
      await recordGuidedUsage({ userId: user.id, projectId: snapshot.project.id, model: inference.model, requestId: inference.requestId, usage: inference.usage });
      response.json({ success: true, data: { ...result, usage: await projectUsageForUser(snapshot.project.id, user.id) } });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/architecture", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      await projectForUser(request.params.projectId, user.id);
      const memory = await loadMemory(request.params.projectId);
      if (!memory) throw new PersistenceError("PROJECT_STATE_MISSING", "This project has no saved memory.", 500);
      const architecture = architectureForMemory({ memory });
      await saveArchitecture(architecture);
      response.json({ success: true, data: architecture });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/srs", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const memory = await loadMemory(project.id);
      if (!memory) throw new PersistenceError("PROJECT_STATE_MISSING", "This project has no saved memory.", 500);
      const document = generateSrs({ memory });
      await saveSrs(document);
      await updateProjectStatus(project.id, "srs_ready");
      response.json({ success: true, data: document });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/srs/:srsId/approve", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      await projectForUser(request.params.projectId, user.id);
      await approveSrs(request.params.projectId, request.params.srsId);
      response.json({ success: true, data: { approvedSrsId: request.params.srsId } });
    } catch (error) { errorResponse(response, error); }
  });

  /** Runs the existing planner inside the canonical project lifecycle. */
  router.post("/projects/:projectId/plan", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const snapshot = await snapshotForUser(project.id, user.id);
      const srs = await loadLatestSrs(project.id);
      if (!srs || srs.status !== "approved") {
        throw new PersistenceError("SRS_APPROVAL_REQUIRED", "Approve the current SRS before generating the implementation prompt.", 400);
      }
      const provider = {
        apiKey: (await getVerifiedOrbioConnection(user.id)).apiKey,
        baseUrl: String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "").trim().replace(/\/+$/, ""),
        model: providerModelId(project.selectedModel),
        retry: false,
      };
      if (!provider.baseUrl) throw new PersistenceError("ORBIO_NOT_CONFIGURED", "ORBIO_BASE_URL is not configured.");
      const planRequest = planningRequestFromApprovedSrs({ project, memory: snapshot.memory, srs });
      const built = await buildPlanWithMetrics({ ...planRequest, aiProvider: provider });
      await saveProjectPlan(project.id, srs.id, built.plan);
      await updateProjectStatus(project.id, "implementation");
      await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "planning", model: built.plan.agentModel ?? provider.model, requestId: built.requestId ?? built.plan.id });
      response.json({ success: true, data: { plan: built.plan, projectId: project.id } });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const existing = await listIterations(project.id);
      const srs = await loadLatestSrs(project.id);
      const architecture = await loadLatestArchitecture(project.id);
      if (!srs || srs.status !== "approved") throw new PersistenceError("ITERATION_NOT_READY", "Approve the project SRS before starting an implementation review.", 400);
      const iteration = createIteration({ project, existing, baseSrsVersionId: srs?.id, baseArchitectureVersionId: architecture?.id, title: String(body(request).title ?? "").trim() });
      await saveIteration(iteration);
      await updateProjectStatus(project.id, "reviewing_repository");
      response.status(201).json({ success: true, data: iteration });
    } catch (error) { errorResponse(response, error); }
  });

  router.get("/projects/:projectId/iterations", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      response.json({ success: true, data: await listIterations(project.id) });
    } catch (error) { errorResponse(response, error); }
  });

  router.get("/projects/:projectId/iterations/:iterationId", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== project.id) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      response.json({ success: true, data: iteration });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/review", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const current = await iterationForUser(request.params.iterationId, user.id);
      if (current.projectId !== project.id) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      if (current.status === "analyzing") throw new PersistenceError("ITERATION_ANALYSIS_IN_PROGRESS", "This iteration is already being analyzed.", 409);
      const parsedReview = projectRequestInput(request);
      const inputBody = parsedReview.input;
      const repositoryUrl = String(inputBody.repositoryUrl ?? "").trim() || undefined;
      const liveUrl = String(inputBody.liveUrl ?? "").trim() || undefined;
      const text = String(inputBody.text ?? "").trim() || undefined;
      const voiceTranscript = String(inputBody.voiceTranscript ?? "").trim() || undefined;
      const forceReview = inputBody.forceReview === true;
      if (!repositoryUrl && !liveUrl && !text && !voiceTranscript && !parsedReview.images.length) throw new PersistenceError("ITERATION_INPUT_REQUIRED", "Provide a repository, live URL, screenshot, or review feedback before analyzing.", 400);
      const connection = await getVerifiedOrbioConnection(user.id);
      const analyzing: ProjectIteration = { ...current, status: "analyzing", updatedAt: new Date().toISOString() };
      const snapshot = await snapshotForUser(project.id, user.id);
      const memory = snapshot.memory;
      const allIterations = await listIterations(project.id);
      const previousCommitSha = [...allIterations].filter((item) => item.id !== current.id && item.repositorySnapshot?.commitSha).sort((a, b) => b.sequenceNumber - a.sequenceNumber)[0]?.repositorySnapshot?.commitSha;
      const screenshotRequestId = randomUUID();
      const [repoResult, liveResult, screenshotResult] = await Promise.all([
        repositoryUrl ? inspectRepository(repositoryUrl, { previousCommitSha, requirementText: memory.requirements.map((item) => item.description) }).then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error })) : Promise.resolve(undefined),
        liveUrl ? inspectLiveProduct(liveUrl).then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error })) : Promise.resolve(undefined),
        parsedReview.images.length ? processSelectedModelReferences({ taskDescription: `Implementation screenshots for ${project.title}`, images: parsedReview.images, requestId: screenshotRequestId, provider: { apiKey: connection.apiKey, baseUrl: String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "").trim().replace(/\/+$/, ""), model: providerModelId(project.selectedModel) } }) : Promise.resolve(undefined),
      ]);
      const now = new Date().toISOString();
      const repositorySnapshot = repoResult?.ok ? repoResult.value : repositoryUrl ? { repositoryUrl, reviewedAt: now, fileCount: 0, relevantFiles: [], structuralSummary: "Repository could not be inspected.", evidenceText: "", status: "unavailable" as const, error: repoResult?.error instanceof Error ? repoResult.error.message : "Repository could not be inspected." } : undefined;
      const liveProductSnapshot = liveResult?.ok ? liveResult.value : liveUrl ? { url: liveUrl, inspectedAt: now, status: "unavailable" as const, error: liveResult?.error instanceof Error ? liveResult.error.message : "Live product could not be inspected." } : undefined;
      if (screenshotResult && !screenshotResult.ok) throw referenceError(screenshotResult.code, screenshotResult.message);
      const screenshotArtifacts = screenshotResult?.ok ? screenshotResult.analyses.map((analysis, index) => ({ id: `screenshot_${current.id}_${index + 1}`, iterationId: current.id, projectId: project.id, filename: parsedReview.images[index]?.filename ?? `screenshot-${index + 1}`, mimeType: parsedReview.images[index]?.mimeType ?? "application/octet-stream", analysis: analysis as unknown as Record<string, unknown>, createdAt: now })) : [];
      await saveScreenshotArtifacts(screenshotArtifacts);
      if (repositorySnapshot?.unchanged && !forceReview && !liveUrl && !text && !voiceTranscript && !parsedReview.images.length) {
        throw new PersistenceError("REPOSITORY_UNCHANGED", "The repository has not changed since the previous review. Add new feedback/live evidence or choose force review to spend inference anyway.", 409);
      }
      await saveIteration(analyzing);
      const changeRequests = extractChangeRequests({ iterationId: current.id, projectId: project.id, text, voiceTranscript, now });
      const evidenceText = [repositorySnapshot?.evidenceText ?? "", JSON.stringify(liveProductSnapshot ?? {}), JSON.stringify(screenshotArtifacts.map((item) => ({ id: item.id, analysis: item.analysis }))), text ?? "", voiceTranscript ?? ""].join("\n").slice(0, 70_000);
      const trace = buildTraceability({ iteration: current, requirements: memory.requirements, acceptanceCriteria: structuredAcceptanceCriteria(memory), evidenceText, hasRepository: Boolean(repositorySnapshot?.status === "reviewed" || repositorySnapshot?.status === "partial"), now });
      const traceFindings = findingsFromTraceability({ iteration: current, traceability: trace.traceability, now });
      const userFindings = changeRequests.map((item) => ({ id: `finding_${item.id}`, iterationId: current.id, projectId: project.id, type: "user_change" as const, severity: item.priority === "high" ? "high" as const : "medium" as const, title: `Requested change: ${item.description.slice(0, 100)}`, description: item.description, plainLanguage: "This is a change explicitly requested by you, not an implementation failure.", requirementIds: [], acceptanceCriteriaIds: [], evidenceIds: [], confidence: "high" as const, impact: "The approved project scope may need to change.", implementationComplexity: "medium" as const, architectureAffected: /payment|database|auth|booking|integration/i.test(item.description), specificationAffected: true, status: "open" as const, createdAt: now }));
      const suggestions = suggestionsForProject({ iteration: current, projectType: project.projectType, memoryText: `${memory.purpose} ${memory.requirements.map((item) => item.description).join(" ")}`, existingTitles: allIterations.flatMap((item) => item.suggestions.map((suggestion) => suggestion.title)), now });
      let report = summarizeIteration({ traceability: trace.traceability, findings: [...traceFindings, ...userFindings], suggestions });
      const reviewed: ProjectIteration = { ...analyzing, status: "review_ready", input: { id: `input_${current.id}`, iterationId: current.id, projectId: project.id, ...(text ? { text } : {}), ...(voiceTranscript ? { voiceTranscript } : {}), screenshotIds: screenshotArtifacts.map((item) => item.id), ...(repositoryUrl ? { repositoryUrl } : {}), ...(liveUrl ? { liveUrl } : {}), createdAt: now }, ...(repositorySnapshot ? { repositorySnapshot } : {}), ...(liveProductSnapshot ? { liveProductSnapshot } : {}), ...(screenshotArtifacts.length ? { screenshotArtifacts } : {}), changeRequests, findings: [...traceFindings, ...userFindings, ...technicalFindings({ iteration: current, evidenceText, now })], evidence: trace.evidence, traceability: trace.traceability, suggestions, reviewedAt: now, report, updatedAt: now };
      if (screenshotArtifacts.length) await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "screenshot_analysis", model: providerModelId(project.selectedModel), requestId: screenshotRequestId });
      try {
        const inference = await runIterationReviewInference({ apiKey: connection.apiKey, project, memory, iteration: reviewed, history: allIterations.filter((item) => item.id !== current.id) });
        const semanticFindings = findingsFromTraceability({ iteration: current, traceability: inference.traceability, now });
        reviewed.traceability = inference.traceability;
        reviewed.evidence = inference.evidence;
        reviewed.suggestions = inference.suggestions;
        reviewed.findings = [...semanticFindings, ...userFindings, ...inference.findings];
        report = { ...summarizeIteration({ traceability: reviewed.traceability, findings: reviewed.findings, suggestions: reviewed.suggestions }), modelSummary: inference.summary };
        reviewed.report = report;
        await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "semantic_review", model: inference.model, requestId: inference.requestId, usage: inference.usage });
      } catch (error) {
        console.error("[guided-project] review synthesis failed", error instanceof Error ? error.message : "unknown");
      }
      await saveIteration(reviewed);
      response.json({ success: true, data: reviewed });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/suggestions/:suggestionId/decision", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== request.params.projectId) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      const decision = String(body(request).decision ?? "");
      if (!["accept", "reject", "defer", "discuss"].includes(decision)) throw new PersistenceError("DECISION_INVALID", "Choose accept, reject, defer, or discuss.", 400);
      const suggestion = iteration.suggestions.find((item) => item.id === request.params.suggestionId);
      if (!suggestion) throw new PersistenceError("SUGGESTION_NOT_FOUND", "That suggestion was not found.", 404);
      const status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : decision === "defer" ? "deferred" : "discussing";
      const now = new Date().toISOString();
      const auditDecision = decision === "accept" ? "accepted" as const : decision === "reject" ? "rejected" as const : "deferred" as const;
      const decisions = decision === "discuss" ? iteration.decisions : [...iteration.decisions, { id: randomUUID(), projectId: iteration.projectId, iterationId: iteration.id, decisionType: "suggestion" as const, subjectId: suggestion.id, decision: auditDecision, rationale: String(body(request).rationale ?? "").trim() || undefined, createdAt: now }];
      const updated: ProjectIteration = { ...iteration, suggestions: iteration.suggestions.map((item) => item.id === suggestion.id ? { ...item, status } : item), decisions, status: decision === "discuss" ? "discussing" : iteration.status, updatedAt: now };
      if (decision === "accept") {
        const messages = await loadSuggestionDiscussion(suggestion.id, project.id);
        let changes: Array<{ description: string; rationale?: string }> = [{ description: `${suggestion.title}: ${suggestion.description}`, rationale: suggestion.rationale }];
        if (messages.length) {
          const scoped = await runSuggestionScopeInference({ apiKey: (await getVerifiedOrbioConnection(user.id)).apiKey, project, memory: (await snapshotForUser(project.id, user.id)).memory, suggestion, messages });
          changes = scoped.changes;
          await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "suggestion_scope", model: scoped.model, requestId: scoped.requestId, usage: scoped.usage });
        }
        updated.changeRequests = [...updated.changeRequests, ...changes.map((change, index) => ({ id: `change_${suggestion.id}_${index + 1}`, iterationId: iteration.id, projectId: iteration.projectId, category: "feature_addition" as const, description: change.description, rationale: change.rationale, source: messages.length ? "discussion" as const : "suggestion" as const, priority: "medium" as const, status: "accepted" as const, createdAt: now }))];
      }
      await saveIteration(updated);
      response.json({ success: true, data: updated });
    } catch (error) { errorResponse(response, error); }
  });

  router.get("/projects/:projectId/iterations/:iterationId/suggestions/:suggestionId/discussion", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== request.params.projectId || !iteration.suggestions.some((item) => item.id === request.params.suggestionId)) throw new PersistenceError("SUGGESTION_NOT_FOUND", "That suggestion was not found.", 404);
      response.json({ success: true, data: await loadSuggestionDiscussion(request.params.suggestionId, iteration.projectId) });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/suggestions/:suggestionId/discussion", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      const suggestion = iteration.suggestions.find((item) => item.id === request.params.suggestionId);
      if (iteration.projectId !== project.id || !suggestion) throw new PersistenceError("SUGGESTION_NOT_FOUND", "That suggestion was not found.", 404);
      const content = String(body(request).content ?? "").trim();
      if (!content || content.length > 4000) throw new PersistenceError("DISCUSSION_VALIDATION_FAILED", "Enter a discussion message of up to 4,000 characters.", 400);
      const messages = await loadSuggestionDiscussion(suggestion.id, project.id);
      const now = new Date().toISOString();
      const userMessage = { id: randomUUID(), suggestionId: suggestion.id, iterationId: iteration.id, projectId: project.id, role: "user" as const, content, createdAt: now };
      const inference = await runSuggestionDiscussionInference({ apiKey: (await getVerifiedOrbioConnection(user.id)).apiKey, project, memory: (await snapshotForUser(project.id, user.id)).memory, suggestion, messages, userMessage: content });
      const assistantMessage = { id: randomUUID(), suggestionId: suggestion.id, iterationId: iteration.id, projectId: project.id, role: "assistant" as const, content: inference.assistantMessage, createdAt: new Date().toISOString() };
      await saveSuggestionDiscussionMessage(userMessage);
      await saveSuggestionDiscussionMessage(assistantMessage);
      const discussion = [...messages, userMessage, assistantMessage];
      const updated = { ...iteration, status: "discussing" as const, suggestions: iteration.suggestions.map((item) => item.id === suggestion.id ? { ...item, status: "discussing" as const } : item), discussions: [...(iteration.discussions ?? []).filter((item) => item.suggestionId !== suggestion.id), ...discussion], updatedAt: assistantMessage.createdAt };
      await saveIteration(updated);
      await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "suggestion_discussion", model: inference.model, requestId: inference.requestId, usage: inference.usage });
      response.json({ success: true, data: { iteration: updated, messages: discussion } });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/findings/:findingId/decision", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== request.params.projectId) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      const decision = String(body(request).decision ?? "");
      if (!["accept", "reject", "defer"].includes(decision)) throw new PersistenceError("DECISION_INVALID", "Choose accept, reject, or defer.", 400);
      if (!iteration.findings.some((item) => item.id === request.params.findingId)) throw new PersistenceError("FINDING_NOT_FOUND", "That finding was not found.", 404);
      const status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "deferred";
      const auditDecision = decision === "accept" ? "accepted" as const : decision === "reject" ? "rejected" as const : "deferred" as const;
      const updated: ProjectIteration = { ...iteration, findings: iteration.findings.map((item) => item.id === request.params.findingId ? { ...item, status } : item), decisions: [...iteration.decisions, { id: randomUUID(), projectId: iteration.projectId, iterationId: iteration.id, decisionType: "finding", subjectId: request.params.findingId, decision: auditDecision, rationale: String(body(request).rationale ?? "").trim() || undefined, createdAt: new Date().toISOString() }], updatedAt: new Date().toISOString() };
      await saveIteration(updated);
      response.json({ success: true, data: updated });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/changes/:changeId/decision", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== request.params.projectId) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      const decision = String(body(request).decision ?? "");
      if (!["accept", "reject", "defer"].includes(decision)) throw new PersistenceError("DECISION_INVALID", "Choose accept, reject, or defer.", 400);
      const status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "clarified";
      const updated: ProjectIteration = { ...iteration, changeRequests: iteration.changeRequests.map((item) => item.id === request.params.changeId ? { ...item, status } : item), status: decision === "accept" ? "changes_approved" : iteration.status, updatedAt: new Date().toISOString() };
      await saveIteration(updated);
      response.json({ success: true, data: updated });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/approve-changes", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== project.id) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      const snapshot = await snapshotForUser(project.id, user.id);
      const acceptedChanges = iteration.changeRequests.filter((item) => item.status === "accepted");
      const accepted = [...acceptedChanges.map((item) => item.description), ...iteration.suggestions.filter((item) => item.status === "accepted" && !acceptedChanges.some((change) => change.id.includes(item.id))).map((item) => `${item.title}: ${item.description}`)];
      if (!accepted.length) { response.json({ success: true, data: iteration }); return; }
      const now = new Date().toISOString();
      const impact = await runChangeImpactInference({ apiKey: (await getVerifiedOrbioConnection(user.id)).apiKey, project, memory: snapshot.memory, changes: accepted });
      const proposal = validateInterviewProposal({ raw: { requirements: [...impact.requirements.new, ...impact.requirements.modified], acceptanceCriteria: [...impact.acceptanceCriteria.new, ...impact.acceptanceCriteria.modified] }, memory: snapshot.memory, userContent: accepted.join("\n"), sourceMessageId: `iteration:${iteration.id}`, now });
      const superseded = new Set(impact.requirements.superseded);
      const memory = { ...snapshot.memory, requirements: proposal.requirements.map((item) => superseded.has(item.id) ? { ...item, status: "superseded" as const, version: item.version + 1, updatedAt: now } : item), acceptanceCriteria: proposal.acceptanceCriteria, risks: [...new Set([...snapshot.memory.risks, ...impact.risks])], technicalConstraints: [...new Set([...snapshot.memory.technicalConstraints, ...impact.securityImplications.map((item) => `Security: ${item}`), ...impact.dataModelChanges.map((item) => `Data model: ${item}`), ...impact.integrationChanges.map((item) => `Integration: ${item}`)])], version: snapshot.memory.version + 1, updatedAt: now };
      await saveMemory(memory);
      await insertRequirements(project.id, memory.requirements);
      await insertAcceptanceCriteria(project.id, structuredAcceptanceCriteria(memory));
      const latestSrs = await loadLatestSrs(project.id);
      const latestArchitecture = await loadLatestArchitecture(project.id);
      const nextSrs = generateSrs({ memory, architecture: latestArchitecture, version: (latestSrs?.version ?? 0) + 1, now });
      const nextArchitecture = architectureForMemory({ memory, previous: latestArchitecture, now });
      await saveSrs(nextSrs);
      if (!latestArchitecture || nextArchitecture.id !== latestArchitecture.id) await saveArchitecture(nextArchitecture);
      const updated: ProjectIteration = { ...iteration, resultingSrsVersionId: nextSrs.id, resultingArchitectureVersionId: nextArchitecture.id, report: iteration.report ? { ...iteration.report, modelSummary: impact.summary } : iteration.report, status: "changes_approved", updatedAt: now };
      await saveIteration(updated);
      await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "change_impact", model: impact.model, requestId: impact.requestId, usage: impact.usage });
      response.json({ success: true, data: { iteration: updated, srs: nextSrs, architecture: nextArchitecture } });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/generate-prompt", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== project.id) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      const snapshot = await snapshotForUser(project.id, user.id);
      const srs = await loadLatestSrs(project.id);
      const architecture = await loadLatestArchitecture(project.id);
      const needsSpecificationUpdate = iteration.changeRequests.some((item) => item.status === "accepted") || iteration.suggestions.some((item) => item.status === "accepted") || iteration.findings.some((item) => item.status === "accepted" && item.specificationAffected);
      if (needsSpecificationUpdate && !iteration.resultingSrsVersionId) throw new PersistenceError("CHANGE_APPROVAL_REQUIRED", "Apply the accepted changes and review the resulting specification before generating the next prompt.", 400);
      if (!srs || srs.status !== "approved") throw new PersistenceError("SRS_APPROVAL_REQUIRED", "Approve the current SRS before generating the next implementation prompt.", 400);
      const draft = generateIterationPrompt({ iteration, memory: snapshot.memory, srs, architecture });
      const inference = await runIterationPromptInference({ apiKey: (await getVerifiedOrbioConnection(user.id)).apiKey, project, draftPrompt: draft.prompt });
      const prompt = { ...draft, prompt: inference.prompt };
      const updated = { ...iteration, generatedPrompt: prompt, status: "prompt_ready" as const, updatedAt: new Date().toISOString() };
      await saveIteration(updated);
      await saveIterationPrompt(prompt);
      await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "correction_prompt", model: inference.model, requestId: inference.requestId, usage: inference.usage });
      response.json({ success: true, data: { iteration: updated, prompt } });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/projects/:projectId/iterations/:iterationId/status", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== request.params.projectId) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      const status = String(body(request).status ?? "") as ProjectIteration["status"];
      if (!["implementation_in_progress", "ready_for_rereview", "completed"].includes(status)) throw new PersistenceError("ITERATION_STATUS_INVALID", "That iteration status cannot be set here.", 400);
      const updated = { ...iteration, status, ...(status === "completed" ? { completedAt: new Date().toISOString() } : {}), updatedAt: new Date().toISOString() };
      await saveIteration(updated);
      response.json({ success: true, data: updated });
    } catch (error) { errorResponse(response, error); }
  });

  return router;
}
