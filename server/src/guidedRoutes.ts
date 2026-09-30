import { createHash, randomUUID } from "node:crypto";
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
import type { InterviewMessage, InterviewSession, PlanningDepth } from "@/types/project";
import type { ProjectAction, ProjectArtifact } from "@/types/conversation";
import {
  AuthUser,
  PersistenceError,
  approveSrsAtomic,
  consumeAuthRateLimit,
  deleteAuthUser,
  deleteProjectForUser,
  insertUsageEvent,
  listProjects,
  loadInterviewStateForUser,
  loadMemory,
  persistenceConfigured,
  projectForUser,
  projectUsageForUser,
  refreshAuthSession,
  saveArchitecture,
  saveProjectSession,
  signIn,
  signUp,
  snapshotForUser,
  iterationForUser,
  listIterations,
  loadLatestArchitecture,
  loadLatestSrs,
  loadProjectArtifacts,
  persistInterviewTurnAtomic,
  persistConversationTurnAtomic,
  persistProjectBootstrapAtomic,
  persistIterationChangeApprovalAtomic,
  requestPasswordReset,
  resendSignupConfirmation,
  saveIteration,
  saveIterationPrompt,
  saveSuggestionDiscussionMessage,
  loadSuggestionDiscussion,
  saveScreenshotArtifacts,
  saveProjectPlanAndStatusAtomic,
  saveSrsAndStatusAtomic,
  updateProjectStatus,
  updatePasswordWithToken,
  userForToken,
} from "./persistence";
import {
  providerModelId,
  runGuidedInterviewInference,
} from "./guidedInterview";
import { inspectGithubActions, inspectLiveProduct, inspectRepository, type GithubCiEvidence } from "./iterationEvidence";
import {
  runChangeImpactInference,
  runIterationPromptInference,
  runIterationReviewInference,
  runSuggestionDiscussionInference,
  runSuggestionScopeInference,
} from "./iterationAgent";
import {
  connectOrbioConnection,
  disconnectOrbioConnection,
  getOrbioBalanceForUser,
  getOrbioConnectionStatus,
  loadOrbioCredentialForInference,
  verifyOrbioConnection,
} from "./orbioConnectionService";
import { runOrbioInference } from "./orbioInference";
import { TranscriptionError, transcribeAudio } from "./transcription";
import {
  buildTraceability,
  createIteration,
  extractChangeRequests,
  findingsFromTraceability,
  generateIterationPrompt,
  suggestionsForProject,
  summarizeIteration,
  technicalFindings,
} from "@/lib/iteration";
import type { ProjectIteration, ProjectSuggestion } from "@/types/iteration";
import type { ProjectReference } from "@/types/project";
import { buildPlanWithMetrics } from "@/lib/planner";
import { planningRequestFromApprovedSrs } from "@/lib/projectMemory/plannerAdapter";
import { applyConversationTurn } from "@/lib/conversation/conversationTurn";
import { routeConversationIntents } from "@/lib/conversation/intentRouter";
import {
  architectureArtifact,
  buildArtifact,
  projectBlueprint,
} from "@/lib/artifacts/artifacts";
import {
  estimateProjectImplementationCredit,
  implementationEstimateMarkdown,
} from "@/lib/estimator/projectEstimate";
import { processReferences, referenceError } from "@/lib/reference";
import type { ReferenceAnalysis, ReferenceInput } from "@/lib/reference/types";
import { MultipartError, parseMultipart } from "./multipart";
import { runPromgentConversation } from "./promgentConversation";
import { discoverNodeTestCommands, repositoryTestRunner } from "./repositoryTestRunner";
import { cachedOrbioCatalogue } from "./orbioModelCatalogue";
import { routeOrbioModel } from "@/lib/models/orbioRouter";

const SESSION_COOKIE = "promgent_session";
const REFRESH_COOKIE = "promgent_refresh";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

function logPerf(
  route: string,
  requestId: string,
  fields: Record<string, number | string>,
): void {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.info(`[perf] requestId=${requestId} route=${route} ${details}`);
}

function cookies(request: express.Request): Record<string, string> {
  const header = String(request.headers.cookie ?? "");
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [];
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      return key ? [[key, decodeURIComponent(value)] as [string, string]] : [];
    }),
  );
}

function setSession(
  response: express.Response,
  token: string,
  refreshToken?: string,
): void {
  const production = process.env.NODE_ENV === "production";
  // The Vercel frontend and Render API are cross-site. `Partitioned` opts the
  // session into CHIPS so browsers that block unpartitioned third-party
  // cookies can still retain this HttpOnly session for the Promgent site.
  const attributes = production
    ? "; Secure; SameSite=None; Partitioned"
    : "; SameSite=Lax";
  const values = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly${attributes}`,
  ];
  values.push(
    refreshToken
      ? `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly${attributes}`
      : `${REFRESH_COOKIE}=; Max-Age=0; Path=/; HttpOnly${attributes}`,
  );
  response.setHeader("Set-Cookie", values);
}

function clearSession(response: express.Response): void {
  const production = process.env.NODE_ENV === "production";
  const attributes = production
    ? "; Secure; SameSite=None; Partitioned"
    : "; SameSite=Lax";
  response.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly${attributes}`,
    `${REFRESH_COOKIE}=; Max-Age=0; Path=/; HttpOnly${attributes}`,
  ]);
}

async function authenticatedUser(request: express.Request): Promise<AuthUser> {
  const stored = cookies(request);
  const token = stored[SESSION_COOKIE];
  const requestId = randomUUID();
  if (!token)
    throw new PersistenceError(
      "AUTH_REQUIRED",
      "Sign in to use Promgent projects.",
      401,
    );
  try {
    return await userForToken(token, requestId);
  } catch (error) {
    if (
      !(error instanceof PersistenceError) ||
      error.code !== "AUTH_VALIDATION_FAILED"
    )
      throw error;
    const refreshToken = stored[REFRESH_COOKIE];
    if (!refreshToken)
      throw new PersistenceError(
        "AUTH_VALIDATION_FAILED",
        "Your session has expired. Please sign in again.",
        401,
      );
    try {
      const refreshed = await refreshAuthSession(refreshToken, requestId);
      if (!refreshed.access_token)
        throw new Error("Supabase returned no access token during refresh.");
      const response = request.res as express.Response | undefined;
      if (response)
        setSession(
          response,
          refreshed.access_token,
          refreshed.refresh_token ?? refreshToken,
        );
      return (
        refreshed.user ??
        (await userForToken(refreshed.access_token, requestId))
      );
    } catch {
      throw new PersistenceError(
        "AUTH_VALIDATION_FAILED",
        "Your session has expired. Please sign in again.",
        401,
      );
    }
  }
}

function body(request: express.Request): Record<string, unknown> {
  return request.body &&
    typeof request.body === "object" &&
    !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : {};
}

function errorResponse(response: express.Response, error: unknown): void {
  if (error instanceof PersistenceError) {
    response
      .status(error.status)
      .json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.requestId ? { requestId: error.requestId } : {}),
        },
      });
    return;
  }
  if (error instanceof AiError) {
    const status =
      error.code === "AI_AUTH_FAILED"
        ? 401
        : error.code === "AI_MODEL_UNAVAILABLE" ||
            error.code === "AI_VALIDATION_FAILED"
          ? 400
          : error.code === "AI_TIMEOUT" ||
              error.code === "AI_RATE_LIMITED" ||
              error.code === "AI_PROVIDER_UNREACHABLE"
            ? 503
            : 502;
    const message =
      error.code === "AI_AUTH_FAILED"
        ? "Orbio rejected the connected key. Reconnect it before continuing."
        : error.code === "AI_MODEL_UNAVAILABLE"
          ? "The selected model is not available through the connected Orbio account."
          : error.code === "AI_TIMEOUT"
            ? "Orbio took too long to answer. Please try this interview turn again."
            : error.code === "AI_RATE_LIMITED"
              ? "Orbio is rate limiting this account. Please wait and try again."
              : "Orbio could not complete this interview turn. Please try again.";
    response
      .status(status)
      .json({
        success: false,
        error: { code: error.code, message, requestId: error.requestId },
      });
    return;
  }
  console.error(
    "[guided-project] unexpected error",
    error instanceof Error ? error.message : "unknown",
  );
  response
    .status(500)
    .json({
      success: false,
      error: {
        code: "PROJECT_OPERATION_FAILED",
        message: "The project operation failed.",
      },
    });
}

async function authRateLimit(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")[0]
    ?.trim();
  const key = forwarded || request.ip || "unknown";
  try {
    const keyHash = createHash("sha256")
      .update(`promgent-auth:${key}`)
      .digest("hex");
    const result = await consumeAuthRateLimit(keyHash);
    if (!result.allowed) {
      response.setHeader("Retry-After", String(result.retry_after));
      return response
        .status(429)
        .json({
          success: false,
          error: {
            code: "AUTH_RATE_LIMITED",
            message:
              "Too many authentication attempts. Please wait and try again.",
          },
        });
    }
    return next();
  } catch (error) {
    console.error(
      "[auth-rate-limit] shared limiter unavailable",
      error instanceof Error ? error.message : "unknown",
    );
    return response
      .status(503)
      .json({
        success: false,
        error: {
          code: "AUTH_RATE_LIMIT_UNAVAILABLE",
          message:
            "Authentication is temporarily unavailable. Please try again shortly.",
        },
      });
  }
}

function validDepth(value: unknown): PlanningDepth {
  return value === "fast" || value === "thorough" ? value : "balanced";
}

function referencesFromInput(
  projectId: string,
  value: unknown,
  now: string,
): ProjectReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item): ProjectReference[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const type =
      raw.type === "image" || raw.type === "website" || raw.type === "file"
        ? raw.type
        : null;
    const source = String(raw.source ?? "")
      .trim()
      .slice(0, 4000);
    if (!type || !source) return [];
    return [
      {
        id: randomUUID(),
        projectId,
        type,
        source,
        metadata:
          raw.metadata && typeof raw.metadata === "object"
            ? (raw.metadata as Record<string, unknown>)
            : {},
        analysis: {
          status: "pending",
          note: "Reference attached at intake; analysis is tracked on the project.",
        },
        createdAt: now,
      },
    ];
  });
}

function projectRequestInput(request: express.Request): {
  input: Record<string, unknown>;
  images: Array<{ buffer: Buffer; mimeType?: string; filename?: string }>;
} {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().includes("multipart/form-data"))
    return { input: body(request), images: [] };
  if (!Buffer.isBuffer(request.body))
    throw new PersistenceError(
      "REFERENCE_ANALYSIS_FAILED",
      "The image upload could not be read.",
      400,
    );
  try {
    const parsed = parseMultipart(request.body, contentType);
    const input = JSON.parse(parsed.fields.payload ?? "{}") as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("invalid payload");
    return {
      input: input as Record<string, unknown>,
      images: parsed.files
        .filter((file) => file.fieldname === "images")
        .map((file) => ({
          buffer: file.buffer,
          mimeType: file.mimetype,
          filename: file.originalname,
        })),
    };
  } catch (error) {
    if (error instanceof MultipartError)
      throw new PersistenceError(error.code, error.message, 400);
    throw new PersistenceError(
      "PROJECT_VALIDATION_FAILED",
      "The project intake payload was malformed.",
      400,
    );
  }
}

function projectReferencesFromAnalysis(
  projectId: string,
  inputs: ReferenceInput[],
  analyses: ReferenceAnalysis[],
  now: string,
): ProjectReference[] {
  return analyses.map((analysis, index) => {
    const reference = inputs[index];
    const source =
      reference?.type === "website"
        ? reference.url
        : reference?.type === "image"
          ? `upload:${reference.filename ?? `image-${index + 1}`}`
          : `reference:${index + 1}`;
    const metadata =
      reference?.type === "image"
        ? {
            filename: reference.filename,
            mimeType: reference.mimeType,
            validatedBytes: Buffer.from(reference.base64, "base64").length,
          }
        : { inspectedUrl: source, visualInspection: analysis.visual };
    return {
      id: randomUUID(),
      projectId,
      type: analysis.type,
      source,
      metadata,
      analysis: analysis as unknown as Record<string, unknown>,
      createdAt: now,
    };
  });
}

async function processSelectedModelReferences(
  input: Parameters<typeof processReferences>[0],
) {
  try {
    return await processReferences(input);
  } catch (error) {
    if (error instanceof AiError && error.code === "AI_AUTH_FAILED")
      throw error;
    if (input.images?.length && error instanceof AiError)
      throw new PersistenceError(
        "MODEL_VISION_UNAVAILABLE",
        "The selected project model could not analyze the supplied image. Choose a vision-capable Orbio model; Promgent will not silently switch models.",
        400,
      );
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
    console.error(
      "[guided-project] usage ledger write failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

export function guidedRouter(): express.Router {
  const router = express.Router();

  router.get("/config", (_request, response) => {
    response.json({
      success: true,
      data: { persistenceConfigured: persistenceConfigured() },
    });
  });

  router.post("/transcribe", async (request, response) => {
    try {
      await authenticatedUser(request);
      const buffer = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      const text = await transcribeAudio({
        buffer,
        mimeType: String(request.headers["content-type"] ?? "audio/webm"),
      });
      response.json({ success: true, data: { text } });
    } catch (error) {
      if (error instanceof TranscriptionError)
        response
          .status(error.status)
          .json({
            success: false,
            error: {
              code: error.code,
              message: error.message,
              requestId: error.requestId,
            },
          });
      else errorResponse(response, error);
    }
  });

  router.post("/auth/signup", authRateLimit, async (request, response) => {
    try {
      const input = body(request);
      const email = String(input.email ?? "").trim();
      const password = String(input.password ?? "");
      if (!email || password.length < 8)
        throw new PersistenceError(
          "AUTH_VALIDATION_FAILED",
          "Use a valid email and a password of at least 8 characters.",
          400,
        );
      const result = await signUp(email, password);
      if (result.access_token)
        setSession(response, result.access_token, result.refresh_token);
      response
        .status(201)
        .json({
          success: true,
          data: {
            authenticated: Boolean(result.access_token),
            user: result.user
              ? { id: result.user.id, email: result.user.email }
              : null,
          },
        });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/auth/signin", authRateLimit, async (request, response) => {
    try {
      const input = body(request);
      const result = await signIn(
        String(input.email ?? "").trim(),
        String(input.password ?? ""),
      );
      if (!result.access_token)
        throw new PersistenceError(
          "AUTH_FAILED",
          "Sign in requires email confirmation or returned no session.",
          401,
        );
      setSession(response, result.access_token, result.refresh_token);
      response.json({
        success: true,
        data: {
          user: result.user
            ? { id: result.user.id, email: result.user.email }
            : null,
        },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/auth/signout", (_request, response) => {
    clearSession(response);
    response.json({ success: true });
  });

  router.post(
    "/auth/password-reset",
    authRateLimit,
    async (request, response) => {
      try {
        const email = String(body(request).email ?? "").trim();
        if (!email)
          throw new PersistenceError(
            "AUTH_VALIDATION_FAILED",
            "Enter your email address.",
            400,
          );
        const redirectTo =
          typeof request.headers.origin === "string"
            ? `${request.headers.origin.replace(/\/+$/, "")}/`
            : undefined;
        await requestPasswordReset(email, redirectTo);
        response.json({
          success: true,
          data: {
            message:
              "If that account exists, a password-reset email has been sent.",
          },
        });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/auth/resend-confirmation",
    authRateLimit,
    async (request, response) => {
      try {
        const email = String(body(request).email ?? "").trim();
        if (!email)
          throw new PersistenceError(
            "AUTH_VALIDATION_FAILED",
            "Enter your email address.",
            400,
          );
        await resendSignupConfirmation(email);
        response.json({
          success: true,
          data: {
            message: "If confirmation is pending, a new email has been sent.",
          },
        });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/auth/complete-password-reset",
    authRateLimit,
    async (request, response) => {
      try {
        const input = body(request);
        const accessToken = String(input.accessToken ?? "");
        const refreshToken = String(input.refreshToken ?? "");
        const password = String(input.password ?? "");
        if (!accessToken || password.length < 8)
          throw new PersistenceError(
            "AUTH_VALIDATION_FAILED",
            "Use a password of at least 8 characters.",
            400,
          );
        const user = await updatePasswordWithToken(accessToken, password);
        setSession(response, accessToken, refreshToken || undefined);
        response.json({
          success: true,
          data: { user: { id: user.id, email: user.email ?? null } },
        });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.get("/auth/session", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      response.json({
        success: true,
        data: {
          authenticated: true,
          user: { id: user.id, email: user.email ?? null },
        },
      });
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "AUTH_REQUIRED") {
        response.json({
          success: true,
          data: { authenticated: false, user: null },
        });
      } else errorResponse(response, error);
    }
  });

  router.get("/orbio/status", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      response.json({
        success: true,
        data: await getOrbioConnectionStatus(user.id),
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/orbio/status/refresh", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const connection = await verifyOrbioConnection(user.id);
      response.json({
        success: true,
        data: {
          connected: true,
          status: "active",
          keyFingerprint: connection.fingerprint,
          modelIds: connection.modelIds,
          balance: connection.balance,
        },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.get("/orbio/balance", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      response.json({
        success: true,
        data: await getOrbioBalanceForUser(user.id),
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/orbio/connect", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const key = String(body(request).apiKey ?? "").trim();
      const connection = await connectOrbioConnection(user.id, key);
      response.json({
        success: true,
        data: {
          connected: true,
          status: "active",
          keyFingerprint: connection.fingerprint,
          modelIds: connection.modelIds,
          balance: connection.balance,
        },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.delete("/orbio/connect", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      await disconnectOrbioConnection(user.id);
      response.json({
        success: true,
        data: {
          connected: false,
          status: "disconnected",
          modelIds: [],
          balance: null,
        },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.get("/projects", async (request, response) => {
    try {
      response.json({
        success: true,
        data: await listProjects((await authenticatedUser(request)).id),
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.get("/account/export", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const projects = await listProjects(user.id);
      const records = await Promise.all(
        projects.map(async (project) => ({
          snapshot: await snapshotForUser(project.id, user.id),
          iterations: await listIterations(project.id),
        })),
      );
      response.setHeader(
        "Content-Disposition",
        `attachment; filename=promgent-export-${new Date().toISOString().slice(0, 10)}.json`,
      );
      response.json({
        success: true,
        data: {
          exportedAt: new Date().toISOString(),
          user: { id: user.id, email: user.email ?? null },
          projects: records,
        },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.delete("/projects/:projectId", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      await deleteProjectForUser(request.params.projectId, user.id);
      response.json({ success: true, data: { deleted: true } });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.delete("/account", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      await deleteAuthUser(user.id);
      clearSession(response);
      response.json({ success: true, data: { deleted: true } });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/projects", async (request, response) => {
    const perfStarted = Date.now();
    const perfRequestId = randomUUID();
    try {
      const authStarted = Date.now();
      const user = await authenticatedUser(request);
      const authMs = Date.now() - authStarted;
      const parsedRequest = projectRequestInput(request);
      const input = parsedRequest.input;
      const description = String(input.description ?? "").trim();
      const budget = Number(input.budget);
      const modelId = String(input.modelId ?? "auto").trim() || "auto";
      if (
        !description ||
        description.length > 8000 ||
        !Number.isFinite(budget) ||
        budget <= 0
      ) {
        throw new PersistenceError(
          "PROJECT_VALIDATION_FAILED",
          "Provide a task description and a valid CREDIT budget.",
          400,
        );
      }
      // Resolve once per request, then reuse this exact locally decrypted
      // credential. No /models or balance request is on the inference path.
      const credentialStarted = Date.now();
      const connection = await loadOrbioCredentialForInference(user.id);
      const credentialMs = Date.now() - credentialStarted;
      const project = {
        ...createProjectRecord({
          userId: user.id,
          id: randomUUID(),
          description,
          modelId,
          planningDepth: validDepth(input.planningDepth),
          budget,
        }),
        status: "interviewing" as const,
      };
      let memory = createInitialMemory(project);
      const declaredReferences = Array.isArray(input.references)
        ? input.references
        : [];
      const urls = declaredReferences
        .flatMap((item) =>
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "website"
            ? [String((item as { source?: unknown }).source ?? "").trim()]
            : [],
        )
        .filter(Boolean);
      const referenceRequestId = randomUUID();
      const referenceStarted = Date.now();
      const referenceModel = project.selectedModel === "auto" && (parsedRequest.images.length || urls.length)
        ? routeOrbioModel({
            models: cachedOrbioCatalogue(),
            mode: "auto",
            taskClass: "image_analysis",
            requiredModalities: parsedRequest.images.length ? ["text", "image"] : ["text"],
            contextTokens: 16_000,
          }).model.id
        : providerModelId(project.selectedModel);
      const referenceResult = await runOrbioInference(
        user.id,
        () =>
          processSelectedModelReferences({
            taskDescription: description,
            images: parsedRequest.images,
            urls,
            requestId: referenceRequestId,
            provider: {
              apiKey: connection.apiKey,
              baseUrl: String(
                process.env.ORBIO_BASE_URL ??
                  process.env.AGENTFUND_AI_BASE_URL ??
                  "",
              )
                .trim()
                .replace(/\/+$/, ""),
              model: referenceModel,
            },
          }),
        connection,
      );
      const referenceMs = Date.now() - referenceStarted;
      if (!referenceResult.ok)
        throw referenceError(referenceResult.code, referenceResult.message);
      const analyzedReferences = projectReferencesFromAnalysis(
        project.id,
        referenceResult.references,
        referenceResult.analyses,
        project.createdAt,
      );
      const legacyReferences = referenceResult.references.length
        ? []
        : referencesFromInput(project.id, input.references, project.createdAt);
      const references = [...analyzedReferences, ...legacyReferences];
      if (referenceResult.analyses.length)
        memory = {
          ...memory,
          designPreferences: [
            ...new Set([
              ...memory.designPreferences,
              ...referenceResult.analyses.map(
                (analysis) =>
                  `Reference observation (${analysis.type}, ${analysis.visual ? "visual" : "structure only"}): ${analysis.summary}`,
              ),
            ]),
          ],
          version: memory.version + 1,
          updatedAt: project.createdAt,
        };
      const session: InterviewSession = {
        id: randomUUID(),
        projectId: project.id,
        planningDepth: project.planningDepth,
        status: "active",
        nextQuestion: memory.openQuestions[0],
        turnCount: 0,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      const inferenceStarted = Date.now();
      const inference = await runOrbioInference(
        user.id,
        () =>
          runPromgentConversation({
            apiKey: connection.apiKey,
            project,
            memory,
            recentMessages: [],
            userContent: description,
          }),
        connection,
      );
      const interviewInferenceMs = Date.now() - inferenceStarted;
      const intakeProposal = validateInterviewProposal({
        raw: inference.structuredMemoryProposal,
        memory,
        userContent: description,
        sourceMessageId: `intake:${project.id}`,
        now: project.createdAt,
        fallbackToUserContent: false,
      });
      const intakeDraft = {
        ...memory,
        requirements: intakeProposal.requirements,
        acceptanceCriteria: intakeProposal.acceptanceCriteria,
        users: [...new Set([...memory.users, ...intakeProposal.users])],
        assumptions: [
          ...new Set([...memory.assumptions, ...intakeProposal.assumptions]),
        ],
        designPreferences: [
          ...new Set([
            ...memory.designPreferences,
            ...intakeProposal.designPreferences,
          ]),
        ],
        technicalConstraints: [
          ...new Set([
            ...memory.technicalConstraints,
            ...intakeProposal.technicalConstraints,
          ]),
        ],
        version: memory.version + 1,
        updatedAt: project.createdAt,
      };
      const intakeConflicts = detectContradictions(intakeDraft);
      const intakeWithConflicts = {
        ...intakeDraft,
        conflicts: intakeConflicts,
      };
      memory = {
        ...intakeWithConflicts,
        openQuestions: refreshQuestionBacklog(intakeWithConflicts),
        completeness: calculateCompleteness(
          intakeWithConflicts,
          project.planningDepth,
        ),
      };
      session.nextQuestion = memory.openQuestions[0];
      const assistantMessage = {
        id: randomUUID(),
        projectId: project.id,
        sessionId: session.id,
        role: "assistant" as const,
        content: inference.response.message,
        source: "system" as const,
        modelRoute: {
          ...inference.route,
          requestId: inference.requestId,
          modelMode: project.modelMode ?? "auto",
        },
        createdAt: project.createdAt,
      };
      const persistenceStarted = Date.now();
      await persistProjectBootstrapAtomic({
        userId: user.id,
        project,
        memory,
        references,
        session,
        assistantMessage,
        requestId: inference.requestId || perfRequestId,
      });
      const persistenceMs = Date.now() - persistenceStarted;
      const usageStarted = Date.now();
      await Promise.all([
        recordGuidedUsage({
          userId: user.id,
          projectId: project.id,
          model: inference.model,
          requestId: inference.requestId,
          usage: inference.usage,
        }),
        ...(referenceResult.analyses.length
          ? [
              recordGuidedUsage({
                userId: user.id,
                projectId: project.id,
                phase: "reference_analysis",
                model: referenceModel,
                requestId: referenceRequestId,
              }),
            ]
          : []),
      ]);
      const usage = await projectUsageForUser(project.id, user.id);
      const usageMs = Date.now() - usageStarted;
      logPerf("create_project", perfRequestId, {
        authMs,
        credentialMs,
        referenceMs,
        interviewInferenceMs,
        providerMs: inference.durationMs,
        persistenceMs,
        usageMs,
        totalMs: Date.now() - perfStarted,
      });
      response
        .status(201)
        .json({
          success: true,
          data: {
            project,
            memory,
            interview: session,
            assistantMessage,
            references,
            usage,
          },
        });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.get("/projects/:projectId", async (request, response) => {
    try {
      response.json({
        success: true,
        data: await snapshotForUser(
          request.params.projectId,
          (await authenticatedUser(request)).id,
        ),
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.get("/projects/:projectId/usage", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      response.json({
        success: true,
        data: await projectUsageForUser(request.params.projectId, user.id),
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/projects/:projectId/interview", async (request, response) => {
    const perfStarted = Date.now();
    const perfRequestId = randomUUID();
    try {
      const authStarted = Date.now();
      const user = await authenticatedUser(request);
      const authMs = Date.now() - authStarted;
      let databaseReadMs = 0;
      let credentialMs = 0;
      const [state, credential] = await Promise.all([
        (async () => {
          const started = Date.now();
          const value = await loadInterviewStateForUser(
            request.params.projectId,
            user.id,
          );
          databaseReadMs = Date.now() - started;
          return value;
        })(),
        (async () => {
          const started = Date.now();
          const value = await loadOrbioCredentialForInference(user.id);
          credentialMs = Date.now() - started;
          return value;
        })(),
      ]);
      const content = String(body(request).content ?? "").trim();
      if (!content || content.length > 8000)
        throw new PersistenceError(
          "INTERVIEW_VALIDATION_FAILED",
          "Enter a response before sending it.",
          400,
        );
      const providerStarted = Date.now();
      const inference = await runOrbioInference(
        user.id,
        () =>
          runGuidedInterviewInference({
            apiKey: credential.apiKey,
            project: state.project,
            memory: state.memory,
            userContent: content,
          }),
        credential,
      );
      const providerMs = Date.now() - providerStarted;
      const result = applyInterviewTurn({
        memory: state.memory,
        session: state.interview,
        content,
        source:
          body(request).source === "voice_transcript"
            ? "voice_transcript"
            : "text",
        assistantContent: inference.assistantContent,
        structuredProposal: inference.structuredProposal,
      });
      // The provider has already charged the user's key at this point. Record
      // that charge before project-state persistence so a failed RPC cannot
      // make the project budget silently under-report real usage.
      const usageStarted = Date.now();
      await recordGuidedUsage({
        userId: user.id,
        projectId: state.project.id,
        model: inference.model,
        requestId: inference.requestId,
        usage: inference.usage,
      });
      const usageMs = Date.now() - usageStarted;
      let persistenceMs = 0;
      const persistenceStarted = Date.now();
      await persistInterviewTurnAtomic({
        userId: user.id,
        projectId: state.project.id,
        userMessage: result.userMessage,
        assistantMessage: result.assistantMessage,
        memory: result.memory,
        session: result.session,
        requestId: inference.requestId || perfRequestId,
      });
      persistenceMs = Date.now() - persistenceStarted;
      const usage = await projectUsageForUser(state.project.id, user.id);
      const totalMs = Date.now() - perfStarted;
      const overheadMs = Math.max(0, totalMs - providerMs);
      logPerf("interview", inference.requestId || perfRequestId, {
        authMs,
        databaseReadMs,
        credentialMs,
        providerMs,
        providerReportedMs: inference.providerDurationMs ?? "-",
        persistenceMs,
        usageMs,
        finishReason: inference.finishReason ?? "-",
        totalMs,
      });
      if (process.env.NODE_ENV !== "production")
        response.setHeader(
          "Server-Timing",
          `auth;dur=${authMs}, db;dur=${databaseReadMs}, credential;dur=${credentialMs}, provider;dur=${providerMs}, persistence;dur=${persistenceMs}, total;dur=${totalMs}`,
        );
      response.json({
        success: true,
        data: {
          ...result,
          usage,
          timing: {
            providerInferenceMs: providerMs,
            promgentOverheadMs: overheadMs,
          },
        },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/projects/:projectId/conversation", async (request, response) => {
    const perfStarted = Date.now();
    const fallbackRequestId = randomUUID();
    try {
      const user = await authenticatedUser(request);
      const parsedConversation = projectRequestInput(request);
      const conversationInput = parsedConversation.input;
      const content = String(conversationInput.content ?? "").trim();
      if (!content || content.length > 8000)
        throw new PersistenceError(
          "CONVERSATION_VALIDATION_FAILED",
          "Enter a message of up to 8,000 characters.",
          400,
        );
      let databaseReadMs = 0;
      let credentialMs = 0;
      const [state, credential, previousArtifacts, previousArchitecture] =
        await Promise.all([
          (async () => {
            const started = Date.now();
            const value = await loadInterviewStateForUser(
              request.params.projectId,
              user.id,
            );
            databaseReadMs = Date.now() - started;
            return value;
          })(),
          (async () => {
            const started = Date.now();
            const value = await loadOrbioCredentialForInference(user.id);
            credentialMs = Date.now() - started;
            return value;
          })(),
          loadProjectArtifacts(request.params.projectId),
          loadLatestArchitecture(request.params.projectId),
        ]);
      const recentMessages = (
        await snapshotForUser(state.project.id, user.id)
      ).messages.slice(-8);
      const intents = routeConversationIntents(content);
      let repositoryRetrievalMs = 0;
      let repositorySnapshot: Awaited<ReturnType<typeof inspectRepository>> | undefined;
      let ciEvidence: GithubCiEvidence | undefined;
      let testRun: Awaited<ReturnType<typeof repositoryTestRunner.run>> | undefined;
      let liveProductSnapshot: Awaited<ReturnType<typeof inspectLiveProduct>> | undefined;
      let imageAnalyses: ReferenceAnalysis[] = [];
      let imageAnalysisMs = 0;
      if (intents.includes("repository_review")) {
        const repositoryUrl = content.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i)?.[0]?.replace(/[),.;]+$/, "");
        if (repositoryUrl) {
          const repositoryStarted = Date.now();
          repositorySnapshot = await inspectRepository(repositoryUrl, {
            ...(state.memory.currentReviewedCommit
              ? { previousCommitSha: state.memory.currentReviewedCommit }
              : {}),
            requirementText: state.memory.requirements.map((item) => item.description),
          });
          ciEvidence = await inspectGithubActions(repositorySnapshot);
          const commands = discoverNodeTestCommands(repositorySnapshot.evidenceText);
          testRun = await repositoryTestRunner.run({
            projectId: state.project.id,
            snapshot: repositorySnapshot,
            commands,
            explicitlyAuthorized: false,
          });
          repositoryRetrievalMs = Date.now() - repositoryStarted;
        }
      }
      if (intents.includes("live_product_review")) {
        const liveUrl = content.match(/https:\/\/(?!github\.com)[^\s<>()]+/i)?.[0]?.replace(/[),.;]+$/, "");
        if (liveUrl) {
          const liveStarted = Date.now();
          liveProductSnapshot = await inspectLiveProduct(liveUrl);
          repositoryRetrievalMs += Date.now() - liveStarted;
        }
      }
      if (parsedConversation.images.length) {
        const imageStarted = Date.now();
        const imageRequestId = randomUUID();
        const imageModel = routeOrbioModel({
          models: cachedOrbioCatalogue(),
          mode: state.project.modelMode ?? (state.project.selectedModel === "auto" ? "auto" : "locked"),
          ...(state.project.selectedModel !== "auto"
            ? { lockedModel: providerModelId(state.project.selectedModel) }
            : {}),
          taskClass: "image_analysis",
          requiredModalities: ["text", "image"],
          contextTokens: 16_000,
        }).model.id;
        const analyzed = await runOrbioInference(
          user.id,
          () => processSelectedModelReferences({
            taskDescription: content,
            images: parsedConversation.images,
            urls: [],
            requestId: imageRequestId,
            provider: {
              apiKey: credential.apiKey,
              baseUrl: String(process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "").trim().replace(/\/+$/, ""),
              model: imageModel,
            },
          }),
          credential,
        );
        if (!analyzed.ok) throw referenceError(analyzed.code, analyzed.message);
        imageAnalyses = analyzed.analyses;
        await recordGuidedUsage({ userId: user.id, projectId: state.project.id, phase: "image_analysis", model: imageModel, requestId: imageRequestId });
        imageAnalysisMs = Date.now() - imageStarted;
      }
      const providerStarted = Date.now();
      const inference = await runOrbioInference(
        user.id,
        () =>
          runPromgentConversation({
            apiKey: credential.apiKey,
            project: state.project,
            memory: state.memory,
            recentMessages,
            userContent: content,
            ...(repositorySnapshot || liveProductSnapshot || imageAnalyses.length
              ? {
                  externalEvidence: [
                    repositorySnapshot?.evidenceText ?? "No repository was supplied.",
                    ciEvidence?.summary ?? "CI evidence was not inspected.",
                    testRun?.summary ?? "No Promgent test-runner evidence exists.",
                    liveProductSnapshot ? `Safely inspected live product data: ${JSON.stringify(liveProductSnapshot)}` : "No live product was supplied.",
                    imageAnalyses.length ? `Analyzed user-supplied image data: ${JSON.stringify(imageAnalyses)}` : "No image was supplied.",
                  ].join("\n\n"),
                }
              : {}),
          }),
        credential,
      );
      const providerMs = Date.now() - providerStarted;
      const allowedSources = new Set([
        "text",
        "voice_transcript",
        "image",
        "website_reference",
        "repository",
        "live_url",
      ]);
      const requestedSource = String(conversationInput.source ?? "text");
      let turn = applyConversationTurn({
        memory: state.memory,
        session: state.interview,
        content,
        source: repositorySnapshot
          ? "repository"
          : liveProductSnapshot
            ? "live_url"
            : imageAnalyses.length
              ? "image"
            : allowedSources.has(requestedSource)
          ? (requestedSource as InterviewMessage["source"])
          : "text",
        intents: inference.response.intents,
        response: inference.response,
        structuredMemoryProposal: inference.structuredMemoryProposal,
      });
      if (repositorySnapshot)
        turn = {
          ...turn,
          memory: {
            ...turn.memory,
            connectedRepository: repositorySnapshot.repositoryUrl,
            currentReviewedCommit: repositorySnapshot.commitSha ?? null,
            currentImplementationState: repositorySnapshot.unchanged
              ? "Repository unchanged since the previous review."
              : `Static review captured commit ${repositorySnapshot.commitSha?.slice(0, 12) ?? "unknown"}.`,
            projectPhase: "reviewing",
          },
        };
      if (liveProductSnapshot)
        turn = {
          ...turn,
          memory: {
            ...turn.memory,
            references: [...new Set([...(turn.memory.references ?? []), liveProductSnapshot.url])],
            currentImplementationState: liveProductSnapshot.status === "reviewed"
              ? `Live product safely inspected at ${liveProductSnapshot.inspectedAt}. Browser behavior was not executed.`
              : `Live product inspection was unavailable at ${liveProductSnapshot.inspectedAt}.`,
            projectPhase: "reviewing",
          },
        };
      if (imageAnalyses.length)
        turn = {
          ...turn,
          memory: {
            ...turn.memory,
            designPreferences: [
              ...new Set([
                ...turn.memory.designPreferences,
                ...imageAnalyses.map((analysis) => `Image observation: ${analysis.summary}`),
              ]),
            ],
            references: [
              ...new Set([
                ...(turn.memory.references ?? []),
                ...parsedConversation.images.map((image) => `upload:${image.filename ?? "conversation-image"}`),
              ]),
            ],
            version: turn.memory.version === state.memory.version ? turn.memory.version + 1 : turn.memory.version,
            updatedAt: new Date().toISOString(),
          },
        };
      const requested = [...inference.response.artifactRequests];
      if (
        inference.response.intents.includes("architecture_request") &&
        !requested.some((item) => item.type === "architecture")
      )
        requested.push({
          type: "architecture",
          title: "Architecture",
          reason: "The user asked to see how the project connects.",
        });
      if (
        liveProductSnapshot &&
        !requested.some((item) => item.type === "live_product_review")
      )
        requested.push({
          type: "live_product_review",
          title: "Live product review",
          reason: "The user supplied a live product URL for safe inspection.",
          content: [
            inference.response.message,
            "",
            `URL: ${liveProductSnapshot.url}`,
            `Inspected at: ${liveProductSnapshot.inspectedAt}`,
            `Status: ${liveProductSnapshot.status}`,
            "Evidence category: Observed through bounded server-side document inspection. Interactive browser behavior and runtime flows were not executed.",
          ].join("\n"),
          structuredData: { ...liveProductSnapshot, browserExecution: false },
        });
      if (
        inference.response.intents.includes("credit_estimate_request") &&
        !requested.some((item) => item.type === "cost_estimate")
      )
        requested.push({
          type: "cost_estimate",
          title: "Estimated build budget",
          reason: "The user requested an implementation CREDIT estimate.",
        });
      if (
        repositorySnapshot &&
        !requested.some((item) => item.type === "repository_review")
      )
        requested.push({
          type: "repository_review",
          title: `Review of ${repositorySnapshot.owner}/${repositorySnapshot.name}`,
          reason: "The user supplied a public GitHub repository for review.",
          content: [
            inference.response.message,
            "",
            `Repository: ${repositorySnapshot.repositoryUrl}`,
            `Branch: ${repositorySnapshot.branch ?? "unknown"}`,
            `Exact reviewed commit: ${repositorySnapshot.commitSha ?? "unknown"}`,
            `Reviewed at: ${repositorySnapshot.reviewedAt}`,
            "",
            ciEvidence?.summary ?? "CI evidence was unavailable.",
            testRun?.summary ?? "Promgent did not execute repository code.",
          ].join("\n"),
          structuredData: {
            repositoryUrl: repositorySnapshot.repositoryUrl,
            branch: repositorySnapshot.branch,
            commitSha: repositorySnapshot.commitSha,
            reviewedAt: repositorySnapshot.reviewedAt,
            relevantFiles: repositorySnapshot.relevantFiles,
            changedFiles: repositorySnapshot.changedFiles ?? [],
            ci: ciEvidence ?? null,
            testRun: testRun ?? null,
          },
        });

      const artifactPriority = [
        ...(repositorySnapshot ? ["repository_review"] : []),
        ...(liveProductSnapshot ? ["live_product_review"] : []),
        ...(inference.response.intents.includes("architecture_request") ? ["architecture"] : []),
        ...(inference.response.intents.includes("credit_estimate_request") ? ["cost_estimate"] : []),
      ];
      requested.sort((left, right) => {
        const leftIndex = artifactPriority.indexOf(left.type);
        const rightIndex = artifactPriority.indexOf(right.type);
        return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
      });

      const artifacts: ProjectArtifact[] = [];
      const attachedArtifactIds: string[] = [];
      for (const artifactRequest of requested.slice(0, 4)) {
        const previous = [...previousArtifacts]
          .filter((item) => item.type === artifactRequest.type)
          .sort((a, b) => b.version - a.version)[0];
        let title = artifactRequest.title ?? artifactRequest.type;
        let artifactContent = artifactRequest.content ?? "";
        let structuredData = artifactRequest.structuredData ?? {};
        if (artifactRequest.type === "project_blueprint") {
          const blueprint = projectBlueprint(turn.memory);
          title = blueprint.title;
          artifactContent = blueprint.content;
          structuredData = blueprint.structuredData;
        } else if (artifactRequest.type === "architecture") {
          const architecture = architectureForMemory({
            memory: turn.memory,
            previous: previousArchitecture,
          });
          const generated = architectureArtifact(architecture);
          title = generated.title;
          artifactContent = generated.content;
          structuredData = generated.structuredData;
        } else if (artifactRequest.type === "cost_estimate") {
          const estimate = estimateProjectImplementationCredit(
            state.project,
            turn.memory,
          );
          title = "Estimated build budget";
          artifactContent = implementationEstimateMarkdown(estimate);
          structuredData = { ...estimate };
        } else if (
          artifactRequest.type === "repository_review" &&
          repositorySnapshot
        ) {
          title = artifactRequest.title ?? `Review of ${repositorySnapshot.owner}/${repositorySnapshot.name}`;
          artifactContent = [
            artifactContent || inference.response.message,
            "",
            `Repository: ${repositorySnapshot.repositoryUrl}`,
            `Branch: ${repositorySnapshot.branch ?? "unknown"}`,
            `Exact reviewed commit: ${repositorySnapshot.commitSha ?? "unknown"}`,
            `Reviewed at: ${repositorySnapshot.reviewedAt}`,
            "",
            ciEvidence?.summary ?? "CI evidence was unavailable.",
            testRun?.summary ?? "Promgent did not execute repository code.",
          ].join("\n");
          structuredData = {
            ...structuredData,
            repositoryUrl: repositorySnapshot.repositoryUrl,
            branch: repositorySnapshot.branch,
            commitSha: repositorySnapshot.commitSha,
            reviewedAt: repositorySnapshot.reviewedAt,
            relevantFiles: repositorySnapshot.relevantFiles,
            changedFiles: repositorySnapshot.changedFiles ?? [],
            ci: ciEvidence ?? null,
            testRun: testRun ?? null,
          };
        } else if (
          artifactRequest.type === "live_product_review" &&
          liveProductSnapshot
        ) {
          title = artifactRequest.title ?? "Live product review";
          artifactContent = [
            artifactContent || inference.response.message,
            "",
            `URL: ${liveProductSnapshot.url}`,
            `Inspected at: ${liveProductSnapshot.inspectedAt}`,
            `Status: ${liveProductSnapshot.status}`,
            "Evidence category: Observed through bounded server-side document inspection. Interactive browser behavior and runtime flows were not executed.",
          ].join("\n");
          structuredData = { ...structuredData, ...liveProductSnapshot, browserExecution: false };
        }
        if (!artifactContent.trim()) continue;
        const artifact = buildArtifact({
          id: randomUUID(),
          projectId: state.project.id,
          type: artifactRequest.type,
          title,
          content: artifactContent,
          structuredData,
          sourceMessageId: turn.assistantMessage.id,
          previous,
        });
        attachedArtifactIds.push(artifact.id);
        if (artifact !== previous) artifacts.push(artifact);
      }

      const allArtifactIds = attachedArtifactIds;
      const actions: ProjectAction[] = inference.response.suggestedActions.map((action) => ({
        ...action,
        id: randomUUID(),
      }));
      for (const artifact of artifacts)
        actions.push({
          id: randomUUID(),
          type: "view_artifact",
          label: `View ${artifact.title}`,
          payload: { artifactId: artifact.id },
        });
      const assistantMessage = {
        ...turn.assistantMessage,
        artifactIds: allArtifactIds,
        modelRoute: inference.route,
      };
      await recordGuidedUsage({
        userId: user.id,
        projectId: state.project.id,
        phase: inference.route.taskClass,
        model: inference.model,
        requestId: inference.requestId,
        usage: inference.usage,
      });
      const persistenceStarted = Date.now();
      await persistConversationTurnAtomic({
        userId: user.id,
        projectId: state.project.id,
        userMessage: turn.userMessage,
        assistantMessage,
        memory: turn.memory,
        session: turn.session,
        phase: turn.memory.projectPhase ?? "exploring",
        actions,
        artifacts,
        modelRoute: {
          ...inference.route,
          id: randomUUID(),
          requestId: inference.requestId || fallbackRequestId,
          modelMode:
            state.project.modelMode ??
            (state.project.selectedModel === "auto" ? "auto" : "locked"),
          ...(state.project.selectedModel !== "auto"
            ? { requestedModel: state.project.selectedModel }
            : {}),
          ...(inference.usage ? { providerUsage: inference.usage } : {}),
        },
        repositorySnapshot,
        testRun,
      });
      const persistenceMs = Date.now() - persistenceStarted;
      const usage = await projectUsageForUser(state.project.id, user.id);
      logPerf("conversation", inference.requestId || fallbackRequestId, {
        databaseReadMs,
        credentialMs,
        providerMs,
        imageAnalysisMs,
        repositoryRetrievalMs,
        persistenceMs,
        totalMs: Date.now() - perfStarted,
      });
      response.json({
        success: true,
        data: {
          userMessage: turn.userMessage,
          assistantMessage,
          memory: turn.memory,
          interview: turn.session,
          artifacts,
          actions,
          usage,
          repositorySnapshot,
          ciEvidence,
          testRun,
          liveProductSnapshot,
        },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post(
    "/projects/:projectId/architecture",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        await projectForUser(request.params.projectId, user.id);
        const [memory, previous] = await Promise.all([
          loadMemory(request.params.projectId),
          loadLatestArchitecture(request.params.projectId),
        ]);
        if (!memory)
          throw new PersistenceError(
            "PROJECT_STATE_MISSING",
            "This project has no saved memory.",
            500,
          );
        const generated = architectureForMemory({ memory, previous });
        const architecture =
          previous && generated.diagramSource === previous.diagramSource
            ? previous
            : generated;
        if (architecture !== previous) await saveArchitecture(architecture);
        response.json({ success: true, data: architecture });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post("/projects/:projectId/srs", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const [memory, architecture, previous] = await Promise.all([
        loadMemory(project.id),
        loadLatestArchitecture(project.id),
        loadLatestSrs(project.id),
      ]);
      if (!memory)
        throw new PersistenceError(
          "PROJECT_STATE_MISSING",
          "This project has no saved memory.",
          500,
        );
      const document = generateSrs({
        memory,
        architecture,
        version: (previous?.version ?? 0) + 1,
      });
      await saveSrsAndStatusAtomic(user.id, project.id, document);
      response.json({ success: true, data: document });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post(
    "/projects/:projectId/srs/:srsId/approve",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        await projectForUser(request.params.projectId, user.id);
        const memory = await loadMemory(request.params.projectId);
        if (!memory)
          throw new PersistenceError(
            "PROJECT_STATE_MISSING",
            "This project has no saved memory.",
            500,
          );
        if (memory.completeness.level !== "ready") {
          throw new PersistenceError(
            "SPECIFICATION_INCOMPLETE",
            "Resolve the critical requirements gaps before approving this specification.",
            400,
          );
        }
        await approveSrsAtomic(
          user.id,
          request.params.projectId,
          request.params.srsId,
        );
        response.json({
          success: true,
          data: { approvedSrsId: request.params.srsId },
        });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  /** Runs the existing planner inside the canonical project lifecycle. */
  router.post("/projects/:projectId/plan", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const [memory, srs, credential] = await Promise.all([
        loadMemory(project.id),
        loadLatestSrs(project.id),
        loadOrbioCredentialForInference(user.id),
      ]);
      if (!memory)
        throw new PersistenceError(
          "PROJECT_STATE_MISSING",
          "This project has no saved memory.",
          500,
        );
      if (!srs || srs.status !== "approved") {
        throw new PersistenceError(
          "SRS_APPROVAL_REQUIRED",
          "Approve the current SRS before generating the implementation prompt.",
          400,
        );
      }
      const provider = {
        apiKey: credential.apiKey,
        baseUrl: String(
          process.env.ORBIO_BASE_URL ?? process.env.AGENTFUND_AI_BASE_URL ?? "",
        )
          .trim()
          .replace(/\/+$/, ""),
        model: providerModelId(project.selectedModel),
        retry: false,
      };
      if (!provider.baseUrl)
        throw new PersistenceError(
          "ORBIO_NOT_CONFIGURED",
          "ORBIO_BASE_URL is not configured.",
        );
      const planRequest = planningRequestFromApprovedSrs({
        project,
        memory,
        srs,
      });
      const built = await runOrbioInference(
        user.id,
        () => buildPlanWithMetrics({ ...planRequest, aiProvider: provider }),
        credential,
      );
      await saveProjectPlanAndStatusAtomic(
        user.id,
        project.id,
        srs.id,
        built.plan,
      );
      await recordGuidedUsage({
        userId: user.id,
        projectId: project.id,
        phase: "planning",
        model: built.plan.agentModel ?? provider.model,
        requestId: built.requestId ?? built.plan.id,
      });
      response.json({
        success: true,
        data: { plan: built.plan, projectId: project.id },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.post("/projects/:projectId/iterations", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      const existing = await listIterations(project.id);
      const srs = await loadLatestSrs(project.id);
      const architecture = await loadLatestArchitecture(project.id);
      if (!srs || srs.status !== "approved")
        throw new PersistenceError(
          "ITERATION_NOT_READY",
          "Approve the project SRS before starting an implementation review.",
          400,
        );
      const iteration = createIteration({
        project,
        existing,
        baseSrsVersionId: srs?.id,
        baseArchitectureVersionId: architecture?.id,
        title: String(body(request).title ?? "").trim(),
      });
      await saveIteration(iteration);
      await updateProjectStatus(project.id, "reviewing_repository");
      response.status(201).json({ success: true, data: iteration });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.get("/projects/:projectId/iterations", async (request, response) => {
    try {
      const user = await authenticatedUser(request);
      const project = await projectForUser(request.params.projectId, user.id);
      response.json({ success: true, data: await listIterations(project.id) });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  router.get(
    "/projects/:projectId/iterations/:iterationId",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const project = await projectForUser(request.params.projectId, user.id);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (iteration.projectId !== project.id)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        response.json({ success: true, data: iteration });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/review",
    async (request, response) => {
      const perfStarted = Date.now();
      const perfRequestId = randomUUID();
      try {
        const user = await authenticatedUser(request);
        const project = await projectForUser(request.params.projectId, user.id);
        const current = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (current.projectId !== project.id)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        if (current.status === "analyzing")
          throw new PersistenceError(
            "ITERATION_ANALYSIS_IN_PROGRESS",
            "This iteration is already being analyzed.",
            409,
          );
        const parsedReview = projectRequestInput(request);
        const inputBody = parsedReview.input;
        const repositoryUrl =
          String(inputBody.repositoryUrl ?? "").trim() || undefined;
        const liveUrl = String(inputBody.liveUrl ?? "").trim() || undefined;
        const text = String(inputBody.text ?? "").trim() || undefined;
        const voiceTranscript =
          String(inputBody.voiceTranscript ?? "").trim() || undefined;
        const forceReview = inputBody.forceReview === true;
        if (
          !repositoryUrl &&
          !liveUrl &&
          !text &&
          !voiceTranscript &&
          !parsedReview.images.length
        )
          throw new PersistenceError(
            "ITERATION_INPUT_REQUIRED",
            "Provide a repository, live URL, screenshot, or review feedback before analyzing.",
            400,
          );
        const stateStarted = Date.now();
        const [connection, memory, allIterations] = await Promise.all([
          loadOrbioCredentialForInference(user.id),
          loadMemory(project.id),
          listIterations(project.id),
        ]);
        if (!memory)
          throw new PersistenceError(
            "PROJECT_STATE_MISSING",
            "This project has no saved memory.",
            500,
          );
        const databaseReadMs = Date.now() - stateStarted;
        const analyzing: ProjectIteration = {
          ...current,
          status: "analyzing",
          updatedAt: new Date().toISOString(),
        };
        const previousCommitSha = [...allIterations]
          .filter(
            (item) =>
              item.id !== current.id && item.repositorySnapshot?.commitSha,
          )
          .sort((a, b) => b.sequenceNumber - a.sequenceNumber)[0]
          ?.repositorySnapshot?.commitSha;
        const screenshotRequestId = randomUUID();
        const evidenceStarted = Date.now();
        let repositoryFetchMs = 0;
        let liveInspectionMs = 0;
        let screenshotAnalysisMs = 0;
        const [repoResult, liveResult, screenshotResult] = await Promise.all([
          repositoryUrl
            ? (async () => {
                const started = Date.now();
                try {
                  return {
                    ok: true as const,
                    value: await inspectRepository(repositoryUrl, {
                      previousCommitSha,
                      requirementText: memory.requirements.map(
                        (item) => item.description,
                      ),
                    }),
                  };
                } catch (error) {
                  return { ok: false as const, error };
                } finally {
                  repositoryFetchMs = Date.now() - started;
                }
              })()
            : Promise.resolve(undefined),
          liveUrl
            ? (async () => {
                const started = Date.now();
                try {
                  return {
                    ok: true as const,
                    value: await inspectLiveProduct(liveUrl),
                  };
                } catch (error) {
                  return { ok: false as const, error };
                } finally {
                  liveInspectionMs = Date.now() - started;
                }
              })()
            : Promise.resolve(undefined),
          parsedReview.images.length
            ? (async () => {
                const started = Date.now();
                try {
                  return await runOrbioInference(
                    user.id,
                    () =>
                      processSelectedModelReferences({
                        taskDescription: `Implementation screenshots for ${project.title}`,
                        images: parsedReview.images,
                        requestId: screenshotRequestId,
                        provider: {
                          apiKey: connection.apiKey,
                          baseUrl: String(
                            process.env.ORBIO_BASE_URL ??
                              process.env.AGENTFUND_AI_BASE_URL ??
                              "",
                          )
                            .trim()
                            .replace(/\/+$/, ""),
                          model: providerModelId(project.selectedModel),
                        },
                      }),
                    connection,
                  );
                } finally {
                  screenshotAnalysisMs = Date.now() - started;
                }
              })()
            : Promise.resolve(undefined),
        ]);
        const evidenceTotalMs = Date.now() - evidenceStarted;
        const now = new Date().toISOString();
        const repositorySnapshot = repoResult?.ok
          ? repoResult.value
          : repositoryUrl
            ? {
                repositoryUrl,
                reviewedAt: now,
                fileCount: 0,
                relevantFiles: [],
                structuralSummary: "Repository could not be inspected.",
                evidenceText: "",
                status: "unavailable" as const,
                error:
                  repoResult?.error instanceof Error
                    ? repoResult.error.message
                    : "Repository could not be inspected.",
              }
            : undefined;
        const liveProductSnapshot = liveResult?.ok
          ? liveResult.value
          : liveUrl
            ? {
                url: liveUrl,
                inspectedAt: now,
                status: "unavailable" as const,
                error:
                  liveResult?.error instanceof Error
                    ? liveResult.error.message
                    : "Live product could not be inspected.",
              }
            : undefined;
        if (screenshotResult && !screenshotResult.ok)
          throw referenceError(screenshotResult.code, screenshotResult.message);
        const screenshotArtifacts = screenshotResult?.ok
          ? screenshotResult.analyses.map((analysis, index) => ({
              id: `screenshot_${current.id}_${index + 1}`,
              iterationId: current.id,
              projectId: project.id,
              filename:
                parsedReview.images[index]?.filename ??
                `screenshot-${index + 1}`,
              mimeType:
                parsedReview.images[index]?.mimeType ??
                "application/octet-stream",
              analysis: analysis as unknown as Record<string, unknown>,
              createdAt: now,
            }))
          : [];
        await saveScreenshotArtifacts(screenshotArtifacts);
        if (
          repositorySnapshot?.unchanged &&
          !forceReview &&
          !liveUrl &&
          !text &&
          !voiceTranscript &&
          !parsedReview.images.length
        ) {
          throw new PersistenceError(
            "REPOSITORY_UNCHANGED",
            "The repository has not changed since the previous review. Add new feedback/live evidence or choose force review to spend inference anyway.",
            409,
          );
        }
        await saveIteration(analyzing);
        const changeRequests = extractChangeRequests({
          iterationId: current.id,
          projectId: project.id,
          text,
          voiceTranscript,
          now,
        });
        const evidenceText = [
          repositorySnapshot?.evidenceText ?? "",
          JSON.stringify(liveProductSnapshot ?? {}),
          JSON.stringify(
            screenshotArtifacts.map((item) => ({
              id: item.id,
              analysis: item.analysis,
            })),
          ),
          text ?? "",
          voiceTranscript ?? "",
        ]
          .join("\n")
          .slice(0, 70_000);
        const trace = buildTraceability({
          iteration: current,
          requirements: memory.requirements,
          acceptanceCriteria: structuredAcceptanceCriteria(memory),
          evidenceText,
          hasRepository: Boolean(
            repositorySnapshot?.status === "reviewed" ||
              repositorySnapshot?.status === "partial",
          ),
          now,
        });
        const traceFindings = findingsFromTraceability({
          iteration: current,
          traceability: trace.traceability,
          now,
        });
        const userFindings = changeRequests.map((item) => ({
          id: `finding_${item.id}`,
          iterationId: current.id,
          projectId: project.id,
          type: "user_change" as const,
          severity:
            item.priority === "high" ? ("high" as const) : ("medium" as const),
          title: `Requested change: ${item.description.slice(0, 100)}`,
          description: item.description,
          plainLanguage:
            "This is a change explicitly requested by you, not an implementation failure.",
          requirementIds: [],
          acceptanceCriteriaIds: [],
          evidenceIds: [],
          confidence: "high" as const,
          impact: "The approved project scope may need to change.",
          implementationComplexity: "medium" as const,
          architectureAffected:
            /payment|database|auth|booking|integration/i.test(item.description),
          specificationAffected: true,
          status: "open" as const,
          createdAt: now,
        }));
        const suggestions = suggestionsForProject({
          iteration: current,
          projectType: project.projectType,
          memoryText: `${memory.purpose} ${memory.requirements.map((item) => item.description).join(" ")}`,
          existingTitles: allIterations.flatMap((item) =>
            item.suggestions.map((suggestion) => suggestion.title),
          ),
          now,
        });
        let report = summarizeIteration({
          traceability: trace.traceability,
          findings: [...traceFindings, ...userFindings],
          suggestions,
        });
        const reviewed: ProjectIteration = {
          ...analyzing,
          status: "review_ready",
          input: {
            id: `input_${current.id}`,
            iterationId: current.id,
            projectId: project.id,
            ...(text ? { text } : {}),
            ...(voiceTranscript ? { voiceTranscript } : {}),
            screenshotIds: screenshotArtifacts.map((item) => item.id),
            ...(repositoryUrl ? { repositoryUrl } : {}),
            ...(liveUrl ? { liveUrl } : {}),
            createdAt: now,
          },
          ...(repositorySnapshot ? { repositorySnapshot } : {}),
          ...(liveProductSnapshot ? { liveProductSnapshot } : {}),
          ...(screenshotArtifacts.length ? { screenshotArtifacts } : {}),
          changeRequests,
          findings: [
            ...traceFindings,
            ...userFindings,
            ...technicalFindings({ iteration: current, evidenceText, now }),
          ],
          evidence: trace.evidence,
          traceability: trace.traceability,
          suggestions,
          reviewedAt: now,
          report,
          updatedAt: now,
        };
        if (screenshotArtifacts.length)
          await recordGuidedUsage({
            userId: user.id,
            projectId: project.id,
            phase: "screenshot_analysis",
            model: providerModelId(project.selectedModel),
            requestId: screenshotRequestId,
          });
        let semanticReviewMs = 0;
        try {
          const semanticStarted = Date.now();
          const inference = await runOrbioInference(
            user.id,
            () =>
              runIterationReviewInference({
                apiKey: connection.apiKey,
                project,
                memory,
                iteration: reviewed,
                history: allIterations.filter((item) => item.id !== current.id),
              }),
            connection,
          );
          semanticReviewMs = Date.now() - semanticStarted;
          const semanticFindings = findingsFromTraceability({
            iteration: current,
            traceability: inference.traceability,
            now,
          });
          reviewed.traceability = inference.traceability;
          reviewed.evidence = inference.evidence;
          reviewed.suggestions = inference.suggestions;
          reviewed.findings = [
            ...semanticFindings,
            ...userFindings,
            ...inference.findings,
          ];
          report = {
            ...summarizeIteration({
              traceability: reviewed.traceability,
              findings: reviewed.findings,
              suggestions: reviewed.suggestions,
            }),
            modelSummary: inference.summary,
          };
          reviewed.report = report;
          await recordGuidedUsage({
            userId: user.id,
            projectId: project.id,
            phase: "semantic_review",
            model: inference.model,
            requestId: inference.requestId,
            usage: inference.usage,
          });
        } catch (error) {
          if (
            error instanceof PersistenceError &&
            error.code === "ORBIO_KEY_EXPIRED_OR_INVALID"
          )
            throw error;
          console.error(
            "[guided-project] review synthesis failed",
            error instanceof Error ? error.message : "unknown",
          );
        }
        const persistenceStarted = Date.now();
        await saveIteration(reviewed);
        const persistenceMs = Date.now() - persistenceStarted;
        logPerf("repository_review", perfRequestId, {
          databaseReadMs,
          repositoryFetchMs,
          liveInspectionMs,
          screenshotAnalysisMs,
          evidenceTotalMs,
          semanticReviewMs,
          persistenceMs,
          totalMs: Date.now() - perfStarted,
        });
        response.json({ success: true, data: reviewed });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/suggestions/:suggestionId/decision",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const project = await projectForUser(request.params.projectId, user.id);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (iteration.projectId !== request.params.projectId)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        const decision = String(body(request).decision ?? "");
        if (!["accept", "reject", "defer", "discuss"].includes(decision))
          throw new PersistenceError(
            "DECISION_INVALID",
            "Choose accept, reject, defer, or discuss.",
            400,
          );
        const suggestion = iteration.suggestions.find(
          (item) => item.id === request.params.suggestionId,
        );
        if (!suggestion)
          throw new PersistenceError(
            "SUGGESTION_NOT_FOUND",
            "That suggestion was not found.",
            404,
          );
        const status =
          decision === "accept"
            ? "accepted"
            : decision === "reject"
              ? "rejected"
              : decision === "defer"
                ? "deferred"
                : "discussing";
        const now = new Date().toISOString();
        const auditDecision =
          decision === "accept"
            ? ("accepted" as const)
            : decision === "reject"
              ? ("rejected" as const)
              : ("deferred" as const);
        const decisions =
          decision === "discuss"
            ? iteration.decisions
            : [
                ...iteration.decisions,
                {
                  id: randomUUID(),
                  projectId: iteration.projectId,
                  iterationId: iteration.id,
                  decisionType: "suggestion" as const,
                  subjectId: suggestion.id,
                  decision: auditDecision,
                  rationale:
                    String(body(request).rationale ?? "").trim() || undefined,
                  createdAt: now,
                },
              ];
        const updated: ProjectIteration = {
          ...iteration,
          suggestions: iteration.suggestions.map((item) =>
            item.id === suggestion.id ? { ...item, status } : item,
          ),
          decisions,
          status: decision === "discuss" ? "discussing" : iteration.status,
          updatedAt: now,
        };
        if (decision === "accept") {
          const messages = await loadSuggestionDiscussion(
            suggestion.id,
            project.id,
          );
          let changes: Array<{ description: string; rationale?: string }> = [
            {
              description: `${suggestion.title}: ${suggestion.description}`,
              rationale: suggestion.rationale,
            },
          ];
          if (messages.length) {
            const [credential, memory] = await Promise.all([
              loadOrbioCredentialForInference(user.id),
              loadMemory(project.id),
            ]);
            if (!memory)
              throw new PersistenceError(
                "PROJECT_STATE_MISSING",
                "This project has no saved memory.",
                500,
              );
            const scoped = await runOrbioInference(
              user.id,
              () =>
                runSuggestionScopeInference({
                  apiKey: credential.apiKey,
                  project,
                  memory,
                  suggestion,
                  messages,
                }),
              credential,
            );
            changes = scoped.changes;
            await recordGuidedUsage({
              userId: user.id,
              projectId: project.id,
              phase: "suggestion_scope",
              model: scoped.model,
              requestId: scoped.requestId,
              usage: scoped.usage,
            });
          }
          updated.changeRequests = [
            ...updated.changeRequests,
            ...changes.map((change, index) => ({
              id: `change_${suggestion.id}_${index + 1}`,
              iterationId: iteration.id,
              projectId: iteration.projectId,
              category: "feature_addition" as const,
              description: change.description,
              rationale: change.rationale,
              source: messages.length
                ? ("discussion" as const)
                : ("suggestion" as const),
              priority: "medium" as const,
              status: "accepted" as const,
              createdAt: now,
            })),
          ];
        }
        await saveIteration(updated);
        response.json({ success: true, data: updated });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.get(
    "/projects/:projectId/iterations/:iterationId/suggestions/:suggestionId/discussion",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (
          iteration.projectId !== request.params.projectId ||
          !iteration.suggestions.some(
            (item) => item.id === request.params.suggestionId,
          )
        )
          throw new PersistenceError(
            "SUGGESTION_NOT_FOUND",
            "That suggestion was not found.",
            404,
          );
        response.json({
          success: true,
          data: await loadSuggestionDiscussion(
            request.params.suggestionId,
            iteration.projectId,
          ),
        });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/suggestions/:suggestionId/discussion",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const project = await projectForUser(request.params.projectId, user.id);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        const suggestion = iteration.suggestions.find(
          (item) => item.id === request.params.suggestionId,
        );
        if (iteration.projectId !== project.id || !suggestion)
          throw new PersistenceError(
            "SUGGESTION_NOT_FOUND",
            "That suggestion was not found.",
            404,
          );
        const content = String(body(request).content ?? "").trim();
        if (!content || content.length > 4000)
          throw new PersistenceError(
            "DISCUSSION_VALIDATION_FAILED",
            "Enter a discussion message of up to 4,000 characters.",
            400,
          );
        const messages = await loadSuggestionDiscussion(
          suggestion.id,
          project.id,
        );
        const now = new Date().toISOString();
        const userMessage = {
          id: randomUUID(),
          suggestionId: suggestion.id,
          iterationId: iteration.id,
          projectId: project.id,
          role: "user" as const,
          content,
          createdAt: now,
        };
        const [credential, memory] = await Promise.all([
          loadOrbioCredentialForInference(user.id),
          loadMemory(project.id),
        ]);
        if (!memory)
          throw new PersistenceError(
            "PROJECT_STATE_MISSING",
            "This project has no saved memory.",
            500,
          );
        const inference = await runOrbioInference(
          user.id,
          () =>
            runSuggestionDiscussionInference({
              apiKey: credential.apiKey,
              project,
              memory,
              suggestion,
              messages,
              userMessage: content,
            }),
          credential,
        );
        const assistantMessage = {
          id: randomUUID(),
          suggestionId: suggestion.id,
          iterationId: iteration.id,
          projectId: project.id,
          role: "assistant" as const,
          content: inference.assistantMessage,
          createdAt: new Date().toISOString(),
        };
        const discussion = [...messages, userMessage, assistantMessage];
        const updated = {
          ...iteration,
          status: "discussing" as const,
          suggestions: iteration.suggestions.map((item) =>
            item.id === suggestion.id
              ? { ...item, status: "discussing" as const }
              : item,
          ),
          discussions: [
            ...(iteration.discussions ?? []).filter(
              (item) => item.suggestionId !== suggestion.id,
            ),
            ...discussion,
          ],
          updatedAt: assistantMessage.createdAt,
        };
        await Promise.all([
          saveSuggestionDiscussionMessage(userMessage),
          saveSuggestionDiscussionMessage(assistantMessage),
          saveIteration(updated),
          recordGuidedUsage({
            userId: user.id,
            projectId: project.id,
            phase: "suggestion_discussion",
            model: inference.model,
            requestId: inference.requestId,
            usage: inference.usage,
          }),
        ]);
        response.json({
          success: true,
          data: { iteration: updated, messages: discussion },
        });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/findings/:findingId/decision",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (iteration.projectId !== request.params.projectId)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        const decision = String(body(request).decision ?? "");
        if (!["accept", "reject", "defer"].includes(decision))
          throw new PersistenceError(
            "DECISION_INVALID",
            "Choose accept, reject, or defer.",
            400,
          );
        if (
          !iteration.findings.some(
            (item) => item.id === request.params.findingId,
          )
        )
          throw new PersistenceError(
            "FINDING_NOT_FOUND",
            "That finding was not found.",
            404,
          );
        const status =
          decision === "accept"
            ? "accepted"
            : decision === "reject"
              ? "rejected"
              : "deferred";
        const auditDecision =
          decision === "accept"
            ? ("accepted" as const)
            : decision === "reject"
              ? ("rejected" as const)
              : ("deferred" as const);
        const updated: ProjectIteration = {
          ...iteration,
          findings: iteration.findings.map((item) =>
            item.id === request.params.findingId ? { ...item, status } : item,
          ),
          decisions: [
            ...iteration.decisions,
            {
              id: randomUUID(),
              projectId: iteration.projectId,
              iterationId: iteration.id,
              decisionType: "finding",
              subjectId: request.params.findingId,
              decision: auditDecision,
              rationale:
                String(body(request).rationale ?? "").trim() || undefined,
              createdAt: new Date().toISOString(),
            },
          ],
          updatedAt: new Date().toISOString(),
        };
        await saveIteration(updated);
        response.json({ success: true, data: updated });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/changes/:changeId/decision",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (iteration.projectId !== request.params.projectId)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        const decision = String(body(request).decision ?? "");
        if (!["accept", "reject", "defer"].includes(decision))
          throw new PersistenceError(
            "DECISION_INVALID",
            "Choose accept, reject, or defer.",
            400,
          );
        const status =
          decision === "accept"
            ? "accepted"
            : decision === "reject"
              ? "rejected"
              : "clarified";
        const updated: ProjectIteration = {
          ...iteration,
          changeRequests: iteration.changeRequests.map((item) =>
            item.id === request.params.changeId ? { ...item, status } : item,
          ),
          status: decision === "accept" ? "changes_approved" : iteration.status,
          updatedAt: new Date().toISOString(),
        };
        await saveIteration(updated);
        response.json({ success: true, data: updated });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/approve-changes",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const project = await projectForUser(request.params.projectId, user.id);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (iteration.projectId !== project.id)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        const [memoryState, credential] = await Promise.all([
          loadMemory(project.id),
          loadOrbioCredentialForInference(user.id),
        ]);
        if (!memoryState)
          throw new PersistenceError(
            "PROJECT_STATE_MISSING",
            "This project has no saved memory.",
            500,
          );
        const acceptedChanges = iteration.changeRequests.filter(
          (item) => item.status === "accepted",
        );
        const accepted = [
          ...acceptedChanges.map((item) => item.description),
          ...iteration.suggestions
            .filter(
              (item) =>
                item.status === "accepted" &&
                !acceptedChanges.some((change) => change.id.includes(item.id)),
            )
            .map((item) => `${item.title}: ${item.description}`),
        ];
        if (!accepted.length) {
          response.json({ success: true, data: iteration });
          return;
        }
        const now = new Date().toISOString();
        const impact = await runOrbioInference(
          user.id,
          () =>
            runChangeImpactInference({
              apiKey: credential.apiKey,
              project,
              memory: memoryState,
              changes: accepted,
            }),
          credential,
        );
        const proposal = validateInterviewProposal({
          raw: {
            requirements: [
              ...impact.requirements.new,
              ...impact.requirements.modified,
            ],
            acceptanceCriteria: [
              ...impact.acceptanceCriteria.new,
              ...impact.acceptanceCriteria.modified,
            ],
          },
          memory: memoryState,
          userContent: accepted.join("\n"),
          sourceMessageId: `iteration:${iteration.id}`,
          now,
        });
        const superseded = new Set(impact.requirements.superseded);
        const memory = {
          ...memoryState,
          requirements: proposal.requirements.map((item) =>
            superseded.has(item.id)
              ? {
                  ...item,
                  status: "superseded" as const,
                  version: item.version + 1,
                  updatedAt: now,
                }
              : item,
          ),
          acceptanceCriteria: proposal.acceptanceCriteria,
          risks: [...new Set([...memoryState.risks, ...impact.risks])],
          technicalConstraints: [
            ...new Set([
              ...memoryState.technicalConstraints,
              ...impact.securityImplications.map((item) => `Security: ${item}`),
              ...impact.dataModelChanges.map((item) => `Data model: ${item}`),
              ...impact.integrationChanges.map(
                (item) => `Integration: ${item}`,
              ),
            ]),
          ],
          version: memoryState.version + 1,
          updatedAt: now,
        };
        const latestSrs = await loadLatestSrs(project.id);
        const latestArchitecture = await loadLatestArchitecture(project.id);
        const generatedArchitecture = architectureForMemory({
          memory,
          previous: latestArchitecture,
          now,
        });
        const nextArchitecture =
          latestArchitecture &&
          generatedArchitecture.diagramSource ===
            latestArchitecture.diagramSource
            ? latestArchitecture
            : generatedArchitecture;
        const nextSrs = generateSrs({
          memory,
          architecture: nextArchitecture,
          version: (latestSrs?.version ?? 0) + 1,
          now,
        });
        const updated: ProjectIteration = {
          ...iteration,
          resultingSrsVersionId: nextSrs.id,
          resultingArchitectureVersionId: nextArchitecture.id,
          report: iteration.report
            ? { ...iteration.report, modelSummary: impact.summary }
            : iteration.report,
          status: "changes_approved",
          updatedAt: now,
        };
        await persistIterationChangeApprovalAtomic({
          userId: user.id,
          projectId: project.id,
          memory,
          srs: nextSrs,
          architecture:
            nextArchitecture !== latestArchitecture
              ? nextArchitecture
              : undefined,
          iteration: updated,
          requestId: impact.requestId,
        });
        await recordGuidedUsage({
          userId: user.id,
          projectId: project.id,
          phase: "change_impact",
          model: impact.model,
          requestId: impact.requestId,
          usage: impact.usage,
        });
        response.json({
          success: true,
          data: {
            iteration: updated,
            srs: nextSrs,
            architecture: nextArchitecture,
          },
        });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/generate-prompt",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const project = await projectForUser(request.params.projectId, user.id);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (iteration.projectId !== project.id)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        const [memory, srs, architecture, credential] = await Promise.all([
          loadMemory(project.id),
          loadLatestSrs(project.id),
          loadLatestArchitecture(project.id),
          loadOrbioCredentialForInference(user.id),
        ]);
        if (!memory)
          throw new PersistenceError(
            "PROJECT_STATE_MISSING",
            "This project has no saved memory.",
            500,
          );
        const needsSpecificationUpdate =
          iteration.changeRequests.some((item) => item.status === "accepted") ||
          iteration.suggestions.some((item) => item.status === "accepted") ||
          iteration.findings.some(
            (item) => item.status === "accepted" && item.specificationAffected,
          );
        if (needsSpecificationUpdate && !iteration.resultingSrsVersionId)
          throw new PersistenceError(
            "CHANGE_APPROVAL_REQUIRED",
            "Apply the accepted changes and review the resulting specification before generating the next prompt.",
            400,
          );
        if (!srs || srs.status !== "approved")
          throw new PersistenceError(
            "SRS_APPROVAL_REQUIRED",
            "Approve the current SRS before generating the next implementation prompt.",
            400,
          );
        const draft = generateIterationPrompt({
          iteration,
          memory,
          srs,
          architecture,
        });
        const inference = await runOrbioInference(
          user.id,
          () =>
            runIterationPromptInference({
              apiKey: credential.apiKey,
              project,
              draftPrompt: draft.prompt,
            }),
          credential,
        );
        const prompt = { ...draft, prompt: inference.prompt };
        const updated = {
          ...iteration,
          generatedPrompt: prompt,
          status: "prompt_ready" as const,
          updatedAt: new Date().toISOString(),
        };
        await Promise.all([
          saveIteration(updated),
          saveIterationPrompt(prompt),
          recordGuidedUsage({
            userId: user.id,
            projectId: project.id,
            phase: "correction_prompt",
            model: inference.model,
            requestId: inference.requestId,
            usage: inference.usage,
          }),
        ]);
        response.json({ success: true, data: { iteration: updated, prompt } });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  router.post(
    "/projects/:projectId/iterations/:iterationId/status",
    async (request, response) => {
      try {
        const user = await authenticatedUser(request);
        const iteration = await iterationForUser(
          request.params.iterationId,
          user.id,
        );
        if (iteration.projectId !== request.params.projectId)
          throw new PersistenceError(
            "ITERATION_NOT_FOUND",
            "That iteration was not found.",
            404,
          );
        const status = String(
          body(request).status ?? "",
        ) as ProjectIteration["status"];
        if (
          ![
            "implementation_in_progress",
            "ready_for_rereview",
            "completed",
          ].includes(status)
        )
          throw new PersistenceError(
            "ITERATION_STATUS_INVALID",
            "That iteration status cannot be set here.",
            400,
          );
        const updated = {
          ...iteration,
          status,
          ...(status === "completed"
            ? { completedAt: new Date().toISOString() }
            : {}),
          updatedAt: new Date().toISOString(),
        };
        await saveIteration(updated);
        response.json({ success: true, data: updated });
      } catch (error) {
        errorResponse(response, error);
      }
    },
  );

  return router;
}
