import { randomUUID } from "node:crypto";
import express from "express";
import { AiError } from "@/lib/ai/errors";
import {
  applyInterviewTurn,
  architectureForMemory,
  createInitialMemory,
  createProjectRecord,
  generateSrs,
} from "@/lib/projectMemory";
import type { InterviewSession, PlanningDepth } from "@/types/project";
import {
  AuthUser,
  PersistenceError,
  approveSrs,
  encryptOrbioKey,
  fingerprint,
  insertInterviewSession,
  insertMessage,
  insertProject,
  insertRequirements,
  insertUsageEvent,
  listProjects,
  loadOrbioKey,
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
  saveProjectPlan,
  saveProjectReferences,
  updateProjectStatus,
  userForToken,
} from "./persistence";
import { providerModelId, runGuidedInterviewInference } from "./guidedInterview";
import { inspectLiveProduct, inspectRepository } from "./iterationEvidence";
import { runChangeImpactInference, runIterationPromptInference, runIterationReviewInference } from "./iterationAgent";
import { verifyOrbioKey } from "./orbioService";
import { TranscriptionError, transcribeAudio } from "./transcription";
import { buildTraceability, createIteration, extractChangeRequests, findingsFromTraceability, generateIterationPrompt, suggestionsForProject, summarizeIteration, technicalFindings } from "@/lib/iteration";
import { createRequirement } from "@/lib/projectMemory/requirements";
import type { ProjectIteration, ProjectSuggestion } from "@/types/iteration";
import type { ProjectReference } from "@/types/project";
import { buildPlanWithMetrics } from "@/lib/planner";
import { planningRequestFromApprovedSrs } from "@/lib/projectMemory/plannerAdapter";

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
      if (error instanceof TranscriptionError) response.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
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
      // The connection row intentionally exposes only status/fingerprint metadata.
      const rows = await fetchConnectionStatus(user.id);
      response.json({ success: true, data: rows });
    } catch (error) { errorResponse(response, error); }
  });

  router.post("/orbio/connect", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const key = String(body(request).apiKey ?? "").trim();
      await verifyOrbioKey(key);
      await saveConnection(user.id, encryptOrbioKey(key), fingerprint(key));
      response.json({ success: true, data: { connected: true, keyFingerprint: fingerprint(key) } });
    } catch (error) { errorResponse(response, error); }
  });

  router.delete("/orbio/connect", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      await deleteConnection(user.id);
      response.json({ success: true, data: { connected: false } });
    } catch (error) { errorResponse(response, error); }
  });

  router.get("/projects", async (request, response) => {
    try { response.json({ success: true, data: await listProjects((await authenticatedUser(request)).id) }); }
    catch (error) { errorResponse(response, error); }
  });

  router.post("/projects", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const input = body(request);
      const description = String(input.description ?? "").trim();
      const budget = Number(input.budget);
      const modelId = String(input.modelId ?? "auto").trim() || "auto";
      if (!description || description.length > 8000 || !Number.isFinite(budget) || budget <= 0) {
        throw new PersistenceError("PROJECT_VALIDATION_FAILED", "Provide a task description and a valid CREDIT budget.", 400);
      }
      const project = {
        ...createProjectRecord({ userId: user.id, id: randomUUID(), description, modelId, planningDepth: validDepth(input.planningDepth), budget }),
        status: "interviewing" as const,
      };
      const memory = createInitialMemory(project);
      const references = referencesFromInput(project.id, input.references, project.createdAt);
      const session: InterviewSession = { id: randomUUID(), projectId: project.id, planningDepth: project.planningDepth, status: "active", nextQuestion: memory.openQuestions[0], turnCount: 0, createdAt: project.createdAt, updatedAt: project.updatedAt };
      const inference = await runGuidedInterviewInference({ apiKey: await loadOrbioKey(user.id), project, memory, opening: true });
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
      await saveProjectReferences(references);
      await insertInterviewSession(session);
      await insertMessage(assistantMessage);
      await recordGuidedUsage({ userId: user.id, projectId: project.id, model: inference.model, requestId: inference.requestId, usage: inference.usage });
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
      const inference = await runGuidedInterviewInference({ apiKey: await loadOrbioKey(user.id), project: snapshot.project, memory: snapshot.memory, userContent: content });
      const result = applyInterviewTurn({ memory: snapshot.memory, session: snapshot.interview, content, source: body(request).source === "voice_transcript" ? "voice_transcript" : "text", assistantContent: inference.assistantContent });
      await insertMessage(result.userMessage);
      await insertMessage(result.assistantMessage);
      await saveMemory(result.memory);
      await insertRequirements(snapshot.project.id, result.memory.requirements);
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
        apiKey: await loadOrbioKey(user.id),
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
      const inputBody = body(request);
      const repositoryUrl = String(inputBody.repositoryUrl ?? "").trim() || undefined;
      const liveUrl = String(inputBody.liveUrl ?? "").trim() || undefined;
      const text = String(inputBody.text ?? "").trim() || undefined;
      const voiceTranscript = String(inputBody.voiceTranscript ?? "").trim() || undefined;
      if (!repositoryUrl && !liveUrl && !text && !voiceTranscript) throw new PersistenceError("ITERATION_INPUT_REQUIRED", "Provide a repository, live URL, or review feedback before analyzing.", 400);
      const analyzing: ProjectIteration = { ...current, status: "analyzing", updatedAt: new Date().toISOString() };
      await saveIteration(analyzing);
      const [repoResult, liveResult] = await Promise.all([
        repositoryUrl ? inspectRepository(repositoryUrl).then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error })) : Promise.resolve(undefined),
        liveUrl ? inspectLiveProduct(liveUrl).then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error })) : Promise.resolve(undefined),
      ]);
      const now = new Date().toISOString();
      const repositorySnapshot = repoResult?.ok ? repoResult.value : repositoryUrl ? { repositoryUrl, reviewedAt: now, fileCount: 0, relevantFiles: [], structuralSummary: "Repository could not be inspected.", evidenceText: "", status: "unavailable" as const, error: repoResult?.error instanceof Error ? repoResult.error.message : "Repository could not be inspected." } : undefined;
      const liveProductSnapshot = liveResult?.ok ? liveResult.value : liveUrl ? { url: liveUrl, inspectedAt: now, status: "unavailable" as const, error: liveResult?.error instanceof Error ? liveResult.error.message : "Live product could not be inspected." } : undefined;
      const changeRequests = extractChangeRequests({ iterationId: current.id, projectId: project.id, text, voiceTranscript, now });
      const evidenceText = [repositorySnapshot?.evidenceText ?? "", JSON.stringify(liveProductSnapshot ?? {}), text ?? "", voiceTranscript ?? ""].join("\n").slice(0, 70_000);
      const trace = buildTraceability({ iteration: current, requirements: (await snapshotForUser(project.id, user.id)).memory.requirements, evidenceText, hasRepository: Boolean(repositorySnapshot?.status === "reviewed" || repositorySnapshot?.status === "partial"), now });
      const traceFindings = findingsFromTraceability({ iteration: current, traceability: trace.traceability, now });
      const userFindings = changeRequests.map((item) => ({ id: `finding_${item.id}`, iterationId: current.id, projectId: project.id, type: "user_change" as const, severity: item.priority === "high" ? "high" as const : "medium" as const, title: `Requested change: ${item.description.slice(0, 100)}`, description: item.description, plainLanguage: "This is a change explicitly requested by you, not an implementation failure.", requirementIds: [], acceptanceCriteriaIds: [], evidenceIds: [], confidence: "high" as const, impact: "The approved project scope may need to change.", implementationComplexity: "medium" as const, architectureAffected: /payment|database|auth|booking|integration/i.test(item.description), specificationAffected: true, status: "open" as const, createdAt: now }));
      const memory = (await snapshotForUser(project.id, user.id)).memory;
      const allIterations = await listIterations(project.id);
      const suggestions = suggestionsForProject({ iteration: current, projectType: project.projectType, memoryText: `${memory.purpose} ${memory.requirements.map((item) => item.description).join(" ")}`, existingTitles: allIterations.flatMap((item) => item.suggestions.map((suggestion) => suggestion.title)), now });
      let report = summarizeIteration({ traceability: trace.traceability, findings: [...traceFindings, ...userFindings], suggestions });
      const reviewed: ProjectIteration = { ...analyzing, status: "review_ready", input: { id: `input_${current.id}`, iterationId: current.id, projectId: project.id, ...(text ? { text } : {}), ...(voiceTranscript ? { voiceTranscript } : {}), screenshotIds: Array.isArray(inputBody.screenshotIds) ? inputBody.screenshotIds.map(String).slice(0, 8) : [], ...(repositoryUrl ? { repositoryUrl } : {}), ...(liveUrl ? { liveUrl } : {}), createdAt: now }, ...(repositorySnapshot ? { repositorySnapshot } : {}), ...(liveProductSnapshot ? { liveProductSnapshot } : {}), changeRequests, findings: [...traceFindings, ...userFindings, ...technicalFindings({ iteration: current, evidenceText, now })], evidence: trace.evidence, traceability: trace.traceability, suggestions, reviewedAt: now, report, updatedAt: now };
      const reviewKey = await loadOrbioKey(user.id);
      try {
        const inference = await runIterationReviewInference({ apiKey: reviewKey, project, memory, iteration: reviewed });
        report = { ...report, modelSummary: inference.summary };
        reviewed.report = report;
        await recordGuidedUsage({ userId: user.id, projectId: project.id, phase: "repository_review", model: inference.model, requestId: inference.requestId, usage: inference.usage });
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
      const iteration = await iterationForUser(request.params.iterationId, user.id);
      if (iteration.projectId !== request.params.projectId) throw new PersistenceError("ITERATION_NOT_FOUND", "That iteration was not found.", 404);
      const decision = String(body(request).decision ?? "");
      if (!["accept", "reject", "defer", "discuss"].includes(decision)) throw new PersistenceError("DECISION_INVALID", "Choose accept, reject, defer, or discuss.", 400);
      const suggestion = iteration.suggestions.find((item) => item.id === request.params.suggestionId);
      if (!suggestion) throw new PersistenceError("SUGGESTION_NOT_FOUND", "That suggestion was not found.", 404);
      const status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : decision === "defer" ? "deferred" : "discussing";
      const auditDecision = decision === "accept" ? "accepted" as const : decision === "reject" ? "rejected" as const : "deferred" as const;
      const updated: ProjectIteration = { ...iteration, suggestions: iteration.suggestions.map((item) => item.id === suggestion.id ? { ...item, status } : item), decisions: [...iteration.decisions, { id: randomUUID(), projectId: iteration.projectId, iterationId: iteration.id, decisionType: "suggestion", subjectId: suggestion.id, decision: auditDecision, rationale: String(body(request).rationale ?? "").trim() || undefined, createdAt: new Date().toISOString() }], status: decision === "discuss" ? "discussing" : iteration.status, updatedAt: new Date().toISOString() };
      if (decision === "accept") updated.changeRequests = [...updated.changeRequests, { id: `change_${suggestion.id}`, iterationId: iteration.id, projectId: iteration.projectId, category: "feature_addition", description: `${suggestion.title}: ${suggestion.description}`, rationale: suggestion.rationale, source: "suggestion", priority: "medium", status: "proposed", createdAt: new Date().toISOString() }];
      await saveIteration(updated);
      response.json({ success: true, data: updated });
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
      const accepted = [...iteration.changeRequests.filter((item) => item.status === "accepted").map((item) => item.description), ...iteration.suggestions.filter((item) => item.status === "accepted").map((item) => `${item.title}: ${item.description}`)];
      if (!accepted.length) { response.json({ success: true, data: iteration }); return; }
      const now = new Date().toISOString();
      const impact = await runChangeImpactInference({ apiKey: await loadOrbioKey(user.id), project, memory: snapshot.memory, changes: accepted });
      const requirements = accepted.map((description) => createRequirement({ projectId: project.id, description, category: "core_functionality", priority: "high", source: "user", status: "confirmed", confidence: "high", now }));
      const memory = { ...snapshot.memory, requirements: [...snapshot.memory.requirements, ...requirements.filter((item) => !snapshot.memory.requirements.some((existing) => existing.id === item.id))], version: snapshot.memory.version + 1, updatedAt: now };
      await saveMemory(memory);
      await insertRequirements(project.id, memory.requirements);
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
      const inference = await runIterationPromptInference({ apiKey: await loadOrbioKey(user.id), project, draftPrompt: draft.prompt });
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

async function fetchConnectionStatus(userId: string): Promise<{ connected: boolean; keyFingerprint?: string; status?: string }> {
  const base = String(process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!base || !key) throw new PersistenceError("PERSISTENCE_NOT_CONFIGURED", "Persistence is not configured.");
  const response = await fetch(`${base}/rest/v1/orbio_connections?select=key_fingerprint,status&user_id=eq.${encodeURIComponent(userId)}&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new PersistenceError("PERSISTENCE_REQUEST_FAILED", "Could not read the Orbio connection.");
  const rows = (await response.json()) as Array<{ key_fingerprint?: string; status?: string }>;
  return rows[0] ? { connected: true, keyFingerprint: rows[0].key_fingerprint, status: rows[0].status } : { connected: false };
}

async function saveConnection(userId: string, encryptedKey: string, keyFingerprint: string): Promise<void> {
  const base = String(process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!base || !key) throw new PersistenceError("PERSISTENCE_NOT_CONFIGURED", "Persistence is not configured.");
  const response = await fetch(`${base}/rest/v1/orbio_connections?on_conflict=user_id`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ user_id: userId, encrypted_key: encryptedKey, key_fingerprint: keyFingerprint, status: "active", last_verified_at: new Date().toISOString() }]) });
  if (!response.ok) throw new PersistenceError("PERSISTENCE_REQUEST_FAILED", "Could not save the Orbio connection.");
}

async function deleteConnection(userId: string): Promise<void> {
  const base = String(process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!base || !key) throw new PersistenceError("PERSISTENCE_NOT_CONFIGURED", "Persistence is not configured.");
  const response = await fetch(`${base}/rest/v1/orbio_connections?user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE", headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new PersistenceError("PERSISTENCE_REQUEST_FAILED", "Could not disconnect Orbio.");
}
