"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, LogOut, Plus, RefreshCw } from "lucide-react";
import { MODELS } from "@/data/models";
import type { ArchitectureVersion, GuidedProjectSnapshot, PlanningDepth, ProjectRecord, ProjectUsageSummary, SrsDocument } from "@/types/project";
import { approveSrs, connectOrbio, createProject, disconnectOrbio, generateArchitecture, generateProjectPlan, generateSrs, getOrbioBalance, getOrbioStatus, getProjectUsage, getSession, isUsableOrbioStatus, listProjects, loadProject, sendInterview, signIn, signOut, signUp, transcribeAudio, GuidedApiError, type GuidedUser, type OrbioBalance, type OrbioConnectionState, type OrbioStatus } from "@/lib/guidedApi";
import { ORBIO_ACCOUNT_URL, EXTERNAL_LINK_REL } from "@/lib/externalLinks";
import { Button, Field, Select } from "./ui";
import { IterationWorkspace } from "./IterationWorkspace";
import { PromgentLogo } from "./PromgentLogo";
import { canRenderProjectMode, canReviewImplementation, resolveProjectWorkspaceMode, safeProjectReturnMode, type ProjectWorkspaceMode } from "@/lib/projectLifecycle";

type Mode = "loading" | "auth" | "projects" | "create" | ProjectWorkspaceMode;

export function ProjectWorkspace({ onBack }: { onBack?: () => void }) {
  const [mode, setMode] = useState<Mode>("loading");
  const [user, setUser] = useState<GuidedUser | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [snapshot, setSnapshot] = useState<GuidedProjectSnapshot | null>(null);
  const [srs, setSrs] = useState<SrsDocument | null>(null);
  const [implementationPlan, setImplementationPlan] = useState<GuidedProjectSnapshot["implementationPlan"]>();
  const [iterationReturnMode, setIterationReturnMode] = useState<Exclude<ProjectWorkspaceMode, "iteration">>("interview");
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState(MODELS.find((model) => model.id === "gpt-4o")?.id ?? MODELS[0]?.id ?? "auto");
  const [planningDepth, setPlanningDepth] = useState<PlanningDepth>("balanced");
  const [budget, setBudget] = useState("10");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [messageSource, setMessageSource] = useState<"text" | "voice_transcript">("text");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordingTarget, setRecordingTarget] = useState<"intake" | "interview">("interview");
  const recorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const [busy, setBusy] = useState(false);
  const [orbioConnected, setOrbioConnected] = useState(false);
  const [orbioConnectionStatus, setOrbioConnectionStatus] = useState<OrbioConnectionState>("disconnected");
  const [orbioKey, setOrbioKey] = useState("");
  const [orbioFingerprint, setOrbioFingerprint] = useState<string | undefined>();
  const [orbioBalance, setOrbioBalance] = useState<OrbioBalance | null>(null);
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);

  function applyOrbioStatus(status: OrbioStatus) {
    setOrbioConnected(status.connected);
    setOrbioConnectionStatus(status.status);
    setOrbioFingerprint(status.keyFingerprint);
    setOrbioBalance(status.balance ?? null);
    setAvailableModelIds(status.modelIds ?? []);
    if (status.modelIds?.length) {
      const firstAvailable = MODELS.find((model) => model.providerModelId && status.modelIds?.includes(model.providerModelId));
      if (firstAvailable && !status.modelIds.includes(MODELS.find((model) => model.id === modelId)?.providerModelId ?? "")) setModelId(firstAvailable.id);
    }
  }

  async function refreshProjects() {
    setBusy(true);
    try {
      const nextProjects = await listProjects();
      setProjects(nextProjects); setMode("projects"); setError(null);
      void getOrbioStatus().then((status) => {
        applyOrbioStatus(status);
        if (status.connected && status.status === "active") void getOrbioBalance().then(setOrbioBalance).catch(() => undefined);
      }).catch(() => applyOrbioStatus({ connected: false, status: "disconnected", modelIds: [], balance: null }));
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load projects."); }
    finally { setBusy(false); }
  }

  async function handleConnectOrbio() {
    setBusy(true); setError(null);
    try { const status = await connectOrbio(orbioKey); applyOrbioStatus(status); setOrbioKey(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not connect Orbio."); }
    finally { setBusy(false); }
  }

  async function handleDisconnectOrbio() {
    setBusy(true); setError(null);
    try { await disconnectOrbio(); applyOrbioStatus({ connected: false, status: "disconnected", modelIds: [], balance: null }); setProfileOpen(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not disconnect Orbio."); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    getSession().then((session) => { setUser(session.user); return refreshProjects(); }).catch(() => setMode("auth"));
  }, []);

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (authMode === "signin") await signIn(email, password);
      else {
        const result = await signUp(email, password);
        if (!result.authenticated) { setError("Check your email to confirm your account, then sign in."); setAuthMode("signin"); return; }
      }
      await refreshProjects();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Authentication failed."); }
    finally { setBusy(false); }
  }

  async function submitProject(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const references = [
        referenceUrl.trim() ? { type: "website" as const, source: referenceUrl.trim(), metadata: {} } : null,
      ].filter((item): item is NonNullable<typeof item> => Boolean(item));
      const created = await createProject({ description, modelId, planningDepth, budget: Number(budget), references, image: referenceImage });
      setSnapshot({ project: created.project, memory: created.memory, interview: created.interview, messages: [created.assistantMessage], references: created.references ?? [], usage: created.usage });
      setMode("interview");
    } catch (caught) {
      const recoveryCodes = new Set(["ORBIO_NOT_CONNECTED", "ORBIO_CONNECTION_INACTIVE", "ORBIO_CREDENTIAL_UNREADABLE", "ORBIO_KEY_EXPIRED_OR_INVALID"]);
      if (caught instanceof GuidedApiError && caught.code && recoveryCodes.has(caught.code)) {
        try { applyOrbioStatus(await getOrbioStatus()); } catch { applyOrbioStatus({ connected: false, status: "disconnected", modelIds: [], balance: null }); }
        setMode("projects");
      }
      setError(caught instanceof Error ? caught.message : "Could not create the project.");
    }
    finally { setBusy(false); }
  }

  async function openProject(projectId: string) {
    setBusy(true); setError(null);
    try {
      const loaded = await loadProject(projectId);
      setSnapshot(loaded);
      setSrs(loaded.srs ?? null);
      setImplementationPlan(loaded.implementationPlan);
      setMode(resolveProjectWorkspaceMode(loaded));
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load the project."); }
    finally { setBusy(false); }
  }

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!snapshot || !message.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await sendInterview(snapshot.project.id, message, messageSource);
      setSnapshot((current) => current ? { ...current, memory: result.memory, interview: result.session, messages: [...current.messages, result.userMessage, result.assistantMessage], usage: result.usage ?? current.usage } : current);
      void getProjectUsage(snapshot.project.id).then((usage) => setSnapshot((current) => current ? { ...current, usage } : current)).catch(() => undefined);
      setMessage("");
      setMessageSource("text");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The interview turn failed."); }
    finally { setBusy(false); }
  }

  async function makeSrs() {
    if (!snapshot) return;
    setBusy(true); setError(null);
    try {
      const document = await generateSrs(snapshot.project.id);
      setSrs(document);
      setSnapshot((current) => current ? { ...current, srs: document } : current);
      setMode("srs");
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not generate the specification."); }
    finally { setBusy(false); }
  }

  async function makeArchitecture() {
    if (!snapshot) return;
    setBusy(true); setError(null);
    try {
      const architecture = await generateArchitecture(snapshot.project.id);
      setSnapshot((current) => current ? { ...current, architecture } : current);
      setMode("architecture");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not generate architecture."); }
    finally { setBusy(false); }
  }

  async function toggleRecording(target: "intake" | "interview" = "interview") {
    if (recording) { recorder.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const nextRecorder = new MediaRecorder(stream);
      audioChunks.current = [];
      nextRecorder.ondataavailable = (event) => { if (event.data.size) audioChunks.current.push(event.data); };
      nextRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        setTranscribing(true);
        setError(null);
        try {
          const text = await transcribeAudio(new Blob(audioChunks.current, { type: nextRecorder.mimeType || "audio/webm" }));
          if (recordingTarget === "intake") setDescription((current) => `${current}${current.trim() ? "\n" : ""}${text}`);
          else { setMessage(text); setMessageSource("voice_transcript"); }
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Voice transcription failed."); }
        finally { setTranscribing(false); }
      };
      recorder.current = nextRecorder;
      setRecordingTarget(target);
      nextRecorder.start();
      setRecording(true);
    } catch { setError("Microphone access was not granted."); }
  }

  async function approveSpecification() {
    if (!snapshot || !srs || snapshot.memory.completeness.level !== "ready") return;
    setBusy(true); setError(null);
    try {
      await approveSrs(snapshot.project.id, srs.id);
      const approved = { ...srs, status: "approved" as const };
      setSrs(approved);
      setSnapshot((current) => current ? { ...current, srs: approved } : current);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not approve the specification."); }
    finally { setBusy(false); }
  }

  async function makeImplementationPlan() {
    if (!snapshot) return;
    setBusy(true); setError(null);
    try {
      const result = await generateProjectPlan(snapshot.project.id);
      setImplementationPlan(result.plan);
      setSnapshot((current) => current ? { ...current, implementationPlan: result.plan } : current);
      setMode("implementation");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not generate the implementation prompt."); }
    finally { setBusy(false); }
  }

  const progress = useMemo(() => snapshot ? snapshot.memory.completeness : null, [snapshot]);
  const projectMode = mode === "interview" || mode === "architecture" || mode === "srs" || mode === "implementation" || mode === "iteration" ? mode : null;
  const projectModeRenderable = projectMode ? canRenderProjectMode({ mode: projectMode, snapshot, srs, hasImplementationPlan: Boolean(implementationPlan) }) : true;

  function enterIteration() {
    if (!snapshot || !canReviewImplementation({ ...snapshot, implementationPlan })) return;
    setIterationReturnMode(safeProjectReturnMode({ snapshot, srs, hasImplementationPlan: Boolean(implementationPlan) }));
    setMode("iteration");
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-canvas">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex items-center gap-3">
            {onBack ? <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> Promgent</button> : null}
            <span className="inline-flex items-center gap-2 font-mono text-sm font-medium"><PromgentLogo size={30} priority /> Promgent Project</span>
          </div>
          {mode !== "auth" && mode !== "loading" ? <div className="flex items-center gap-4">{snapshot ? <span className="font-mono text-xs text-muted">{snapshot.usage.remaining.toFixed(2)} CREDIT remaining</span> : null}<button type="button" onClick={() => setProfileOpen((current) => !current)} className="text-xs text-muted hover:text-ink">Profile</button><button type="button" onClick={() => { void signOut().finally(() => setMode("auth")); }} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"><LogOut className="h-3.5 w-3.5" /> Sign out</button></div> : null}
        </div>
      </header>
      {profileOpen && mode !== "auth" && mode !== "loading" ? <ProfilePanel user={user} connected={orbioConnected} status={orbioConnectionStatus} fingerprint={orbioFingerprint} balance={orbioBalance} busy={busy} onDisconnect={() => void handleDisconnectOrbio()} onClose={() => setProfileOpen(false)} /> : null}
      <main className="mx-auto w-full max-w-[1000px] px-5 py-8 sm:py-12">
        {mode === "loading" ? <p className="text-center text-sm text-muted">Loading your projects...</p> : null}
        {mode === "auth" ? <AuthCard {...{ authMode, setAuthMode, email, setEmail, password, setPassword, submitAuth, busy, error }} /> : null}
        {mode === "projects" ? <ProjectList projects={projects} busy={busy} onCreate={() => { setError(null); setMode("create"); }} onOpen={(id) => void openProject(id)} onRefresh={() => void refreshProjects()} error={error} orbioConnected={orbioConnected} connectionStatus={orbioConnectionStatus} orbioKey={orbioKey} setOrbioKey={setOrbioKey} onConnect={() => void handleConnectOrbio()} onDisconnect={() => void handleDisconnectOrbio()} balance={orbioBalance} fingerprint={orbioFingerprint} /> : null}
        {mode === "create" ? <CreateProjectCard {...{ description, setDescription, modelId, setModelId, planningDepth, setPlanningDepth, budget, setBudget, referenceUrl, setReferenceUrl, referenceImage, setReferenceImage, submitProject, busy, error, recording, transcribing }} availableModelIds={availableModelIds} onRecord={() => void toggleRecording("intake")} onCancel={() => setMode("projects")} /> : null}
        {mode === "interview" && snapshot ? <InterviewCard snapshot={snapshot} usage={snapshot.usage} progress={progress} message={message} setMessage={(value) => { setMessage(value); setMessageSource("text"); }} messageSource={messageSource} submitMessage={submitMessage} busy={busy} error={error} recording={recording && recordingTarget === "interview"} transcribing={transcribing} onRecord={() => void toggleRecording("interview")} onClearVoice={() => { setMessage(""); setMessageSource("text"); }} onSrs={() => void makeSrs()} onArchitecture={() => void makeArchitecture()} /> : null}
        {mode === "architecture" && snapshot?.architecture ? <ArchitectureCard architecture={snapshot.architecture} projectTitle={snapshot.project.title} busy={busy} onBack={() => setMode("interview")} onSrs={() => void makeSrs()} error={error} /> : null}
        {mode === "srs" && snapshot && srs ? <SrsCard snapshot={snapshot} srs={srs} busy={busy} onBack={() => setMode(snapshot.architecture ? "architecture" : "interview")} onApprove={() => void approveSpecification()} onPlan={() => void makeImplementationPlan()} error={error} /> : null}
        {mode === "implementation" && snapshot && implementationPlan ? <ImplementationCard snapshot={snapshot} plan={implementationPlan} busy={busy} error={error} onBack={() => setMode("srs")} onIteration={enterIteration} /> : null}
        {mode === "iteration" && snapshot && canReviewImplementation({ ...snapshot, implementationPlan }) ? <IterationWorkspace projectId={snapshot.project.id} projectTitle={snapshot.project.title} onBack={() => setMode(iterationReturnMode)} /> : null}
        {projectMode && !projectModeRenderable && snapshot ? <div role="alert" className="mx-auto max-w-[620px] rounded border border-line bg-paper p-6"><h1 className="display text-2xl text-ink">Project state recovered</h1><p className="mt-2 text-sm text-muted">This stage is not available yet. Return to the latest saved project stage to continue.</p><Button className="mt-5" onClick={() => setMode(safeProjectReturnMode({ snapshot, srs, hasImplementationPlan: Boolean(implementationPlan) }))}>Continue project</Button></div> : null}
      </main>
    </div>
  );
}

function ProfilePanel(props: { user: GuidedUser | null; connected: boolean; status: OrbioConnectionState; fingerprint?: string; balance: OrbioBalance | null; busy: boolean; onDisconnect: () => void; onClose: () => void }) {
  const usable = isUsableOrbioStatus(props);
  return <div className="border-b border-line bg-paper"><div className="mx-auto flex max-w-[1000px] items-start justify-between gap-6 px-5 py-5"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Profile</p><p className="mt-2 text-sm text-ink">{props.user?.email ?? "Signed-in user"}</p><p className="mt-4 text-xs uppercase tracking-wide text-muted">Orbio connection</p>{props.connected ? <><p className="mt-1 text-sm text-ink">{usable ? "Connected" : "Needs reconnection"}{props.fingerprint ? ` · ${props.fingerprint}` : ""}</p><p className="mt-3 text-xs uppercase tracking-wide text-muted">Available balance</p><p className="mt-1 font-mono text-lg text-ink">{props.balance ? `${props.balance.available.toFixed(2)} ${props.balance.currency}` : "Unavailable"}</p><Button variant="secondary" onClick={props.onDisconnect} disabled={props.busy} className="mt-4">{props.busy ? "Disconnecting..." : "Disconnect Orbio"}</Button></> : <p className="mt-1 text-sm text-muted">No Orbio key connected.</p>}</div><button type="button" onClick={props.onClose} className="text-xs text-muted hover:text-ink">Close</button></div></div>;
}

function AuthCard(props: { authMode: "signin" | "signup"; setAuthMode: (value: "signin" | "signup") => void; email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; submitAuth: (event: React.FormEvent) => void; busy: boolean; error: string | null }) {
  return <div className="mx-auto max-w-[460px] rounded border border-line bg-paper p-6 sm:p-8"><h1 className="display text-3xl text-ink">{props.authMode === "signin" ? "Welcome back" : "Create your account"}</h1><p className="mt-2 text-sm leading-relaxed text-muted">Projects and requirements are saved securely so you can return to them later.</p><form onSubmit={props.submitAuth} className="mt-7 flex flex-col gap-5"><Field label="Email" htmlFor="guided-email"><input id="guided-email" type="email" required value={props.email} onChange={(event) => props.setEmail(event.target.value)} className="w-full rounded border border-line bg-paper px-3 py-2.5 text-sm" /></Field><Field label="Password" htmlFor="guided-password" hint="At least 8 characters."><input id="guided-password" type="password" required minLength={8} value={props.password} onChange={(event) => props.setPassword(event.target.value)} className="w-full rounded border border-line bg-paper px-3 py-2.5 text-sm" /></Field>{props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}<Button type="submit" disabled={props.busy}>{props.busy ? "Working..." : props.authMode === "signin" ? "Sign in" : "Create account"}</Button></form><button type="button" onClick={() => props.setAuthMode(props.authMode === "signin" ? "signup" : "signin")} className="mt-5 text-sm text-forest hover:underline">{props.authMode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}</button></div>;
}

function ProjectList(props: { projects: ProjectRecord[]; busy: boolean; onCreate: () => void; onOpen: (id: string) => void; onRefresh: () => void; error: string | null; orbioConnected: boolean; connectionStatus: OrbioConnectionState; orbioKey: string; setOrbioKey: (value: string) => void; onConnect: () => void; onDisconnect: () => void; balance: OrbioBalance | null; fingerprint?: string }) {
  const usable = isUsableOrbioStatus({ connected: props.orbioConnected, status: props.connectionStatus });
  return <div><div className="flex items-end justify-between gap-3"><div><h1 className="display text-3xl text-ink">Your projects</h1><p className="mt-2 text-sm text-muted">Each project keeps its requirements, architecture, specification, implementation prompt and review history together.</p></div><Button onClick={props.onCreate} disabled={!usable}><Plus className="h-4 w-4" /> New project</Button></div><div className="mt-7 rounded border border-line bg-paper p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Orbio connection</p><p className="mt-2 text-sm text-ink">{usable ? "Connected. The same connection funds this project's Promgent reasoning." : props.orbioConnected ? "The saved Orbio key needs to be reconnected." : "Connect Orbio before creating a persistent project."}</p>{props.orbioConnected ? <><p className="mt-3 font-mono text-sm text-ink">{props.balance ? `${props.balance.available.toFixed(2)} ${props.balance.currency} available` : "Balance unavailable"}</p><p className="mt-1 text-xs text-muted">Key: {props.fingerprint ?? "connected"}</p><a href={ORBIO_ACCOUNT_URL} target="_blank" rel={EXTERNAL_LINK_REL} className="mt-2 inline-block text-xs text-forest hover:underline">Open Orbio account</a></> : null}</div>{props.orbioConnected ? <Button variant="secondary" onClick={props.onDisconnect} disabled={props.busy}>Disconnect</Button> : null}</div>{!usable ? <div className="mt-4 flex flex-wrap gap-2"><input type="password" value={props.orbioKey} onChange={(event) => props.setOrbioKey(event.target.value)} placeholder="Orbio API key" aria-label="Orbio API key" className="min-w-[240px] flex-1 rounded border border-line bg-paper px-3 py-2.5 text-sm" /><Button onClick={props.onConnect} disabled={props.busy || !props.orbioKey.trim()}>{props.busy ? "Verifying..." : "Verify connection"}</Button></div> : null}</div>{props.error ? <p role="alert" className="mt-5 text-sm text-danger">{props.error}</p> : null}<div className="mt-8 grid gap-3">{props.projects.length ? props.projects.map((project) => <button type="button" key={project.id} onClick={() => props.onOpen(project.id)} className="rounded border border-line bg-paper p-5 text-left hover:border-lineStrong"><div className="flex items-center justify-between gap-3"><span className="font-medium text-ink">{project.title}</span><span className="font-mono text-xs text-muted">{project.status}</span></div><p className="mt-2 line-clamp-2 text-sm text-muted">{project.initialDescription}</p></button>) : <div className="rounded border border-dashed border-line p-8 text-center text-sm text-muted">No projects yet. Start with the idea you want to shape.</div>}</div><button type="button" disabled={props.busy} onClick={props.onRefresh} className="mt-5 inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button></div>;
}

function CreateProjectCard(props: { description: string; setDescription: (value: string) => void; modelId: string; setModelId: (value: string) => void; planningDepth: PlanningDepth; setPlanningDepth: (value: PlanningDepth) => void; budget: string; setBudget: (value: string) => void; referenceUrl: string; setReferenceUrl: (value: string) => void; referenceImage: File | null; setReferenceImage: (value: File | null) => void; submitProject: (event: React.FormEvent) => void; busy: boolean; error: string | null; recording: boolean; transcribing: boolean; availableModelIds: string[]; onRecord: () => void; onCancel: () => void }) {
  const available = props.availableModelIds.length ? MODELS.filter((model) => model.providerModelId && props.availableModelIds.includes(model.providerModelId)) : MODELS;
  return <div className="mx-auto max-w-[760px] rounded border border-line bg-paper p-6 sm:p-8"><p className="font-mono text-xs uppercase tracking-wide text-muted">Project intake</p><h1 className="display mt-1 text-3xl text-ink">Start a new project</h1><p className="mt-2 text-sm leading-relaxed text-muted">Your description becomes the first project requirement. Promgent will continue from here into one persistent requirements workspace.</p><form onSubmit={props.submitProject} className="mt-7 flex flex-col gap-5"><Field label="What do you want to build?" htmlFor="project-description"><div className="relative"><textarea id="project-description" required rows={7} value={props.description} onChange={(event) => props.setDescription(event.target.value)} placeholder="Describe the product in your own words." className="w-full resize-y rounded border border-line bg-paper px-3 py-3 pr-32 text-sm leading-relaxed" /><button type="button" onClick={props.onRecord} disabled={props.busy || props.transcribing} className="absolute bottom-3 right-3 rounded border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink">{props.recording ? "Stop recording" : props.transcribing ? "Transcribing..." : "Record voice"}</button></div>{props.transcribing ? <p className="mt-2 text-xs text-muted">Transcribing… review the editable text before starting.</p> : null}</Field><div className="grid gap-5 sm:grid-cols-3"><Field label="Model" htmlFor="project-model"><Select id="project-model" value={props.modelId} onChange={(event) => props.setModelId(event.target.value)}>{available.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</Select></Field><Field label="Planning depth" htmlFor="project-depth"><Select id="project-depth" value={props.planningDepth} onChange={(event) => props.setPlanningDepth(event.target.value as PlanningDepth)}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="thorough">Thorough</option></Select></Field><Field label="Project CREDIT budget" htmlFor="project-budget"><input id="project-budget" type="number" min="0.1" step="0.5" value={props.budget} onChange={(event) => props.setBudget(event.target.value)} className="w-full rounded border border-line bg-paper px-3 py-2.5 font-mono text-sm" /></Field></div><Field label="Reference website (optional)" htmlFor="project-reference-url"><input id="project-reference-url" type="url" value={props.referenceUrl} onChange={(event) => props.setReferenceUrl(event.target.value)} placeholder="https://example.com" className="w-full rounded border border-line bg-paper px-3 py-2.5 text-sm" /></Field><Field label="Reference image (optional)" htmlFor="project-reference-image"><input id="project-reference-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => props.setReferenceImage(event.target.files?.[0] ?? null)} className="w-full rounded border border-line bg-paper px-3 py-2.5 text-sm" />{props.referenceImage ? <p className="mt-2 text-xs text-muted">Attached: {props.referenceImage.name}. The actual image will be validated and analyzed by the selected project model.</p> : null}</Field>{props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}<div className="flex flex-wrap gap-3"><Button type="submit" disabled={props.busy || props.recording || props.transcribing}>{props.busy ? "Creating..." : "Start Project"}</Button><Button type="button" variant="secondary" onClick={props.onCancel}>Back</Button></div></form></div>;
}

function InterviewCard(props: { snapshot: GuidedProjectSnapshot; usage: ProjectUsageSummary; progress: GuidedProjectSnapshot["memory"]["completeness"] | null; message: string; setMessage: (value: string) => void; messageSource: "text" | "voice_transcript"; submitMessage: (event: React.FormEvent) => void; busy: boolean; error: string | null; recording: boolean; transcribing: boolean; onRecord: () => void; onClearVoice: () => void; onSrs: () => void; onArchitecture: () => void }) {
  const next = props.snapshot.interview.nextQuestion;
  const confirmed = props.snapshot.memory.requirements.filter((item) => item.status === "confirmed").length;
  const proposed = props.snapshot.memory.requirements.filter((item) => item.status === "proposed" || item.status === "inferred").length;
  return <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]"><section className="rounded border border-line bg-paper p-5 sm:p-7"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Requirements interview</p><h1 className="display mt-1 text-3xl text-ink">{props.snapshot.project.title}</h1></div><span className="rounded bg-canvas px-2 py-1 font-mono text-xs text-muted">{props.snapshot.interview.status}</span></div><div className="mt-7 space-y-4">{props.snapshot.messages.length === 0 ? <div className="rounded bg-canvas p-4 text-sm leading-relaxed text-muted">Tell me more about the users, the main workflow and what a successful first version should accomplish.</div> : props.snapshot.messages.map((item) => <div key={item.id} className={item.role === "user" ? "ml-8 rounded bg-forest px-4 py-3 text-sm leading-relaxed text-white" : "mr-8 rounded bg-canvas px-4 py-3 text-sm leading-relaxed text-ink"}>{item.content}</div>)}</div><form onSubmit={props.submitMessage} className="mt-7"><textarea value={props.message} onChange={(event) => props.setMessage(event.target.value)} rows={4} disabled={props.busy || props.recording || props.transcribing} placeholder={next?.question ?? "Add another project detail..."} className="w-full resize-y rounded border border-line bg-paper px-3 py-3 text-sm leading-relaxed" />{props.messageSource === "voice_transcript" ? <p className="mt-2 text-xs text-muted">Transcript ready. Review it before sending.</p> : null}{props.error ? <p role="alert" className="mt-2 text-sm text-danger">{props.error}</p> : null}<div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" onClick={props.onRecord} disabled={props.busy || props.transcribing} className="rounded border border-line px-3 py-2 text-sm text-muted hover:text-ink">{props.recording ? "Stop recording" : props.transcribing ? "Transcribing..." : "Record voice"}</button>{props.messageSource === "voice_transcript" ? <button type="button" onClick={props.onClearVoice} disabled={props.busy} className="rounded border border-line px-3 py-2 text-sm text-muted hover:text-ink">Clear transcript</button> : null}<Button type="submit" disabled={props.busy || props.recording || props.transcribing || !props.message.trim()}>{props.busy ? "Thinking..." : "Send"}</Button></div></form></section><aside className="space-y-4"><UsageCard usage={props.usage} /><div className="rounded border border-line bg-paper p-5"><p className="font-mono text-xs uppercase tracking-wide text-muted">Current understanding</p><div className="mt-3 grid grid-cols-2 gap-2 text-xs"><span>Confirmed: <strong className="text-ink">{confirmed}</strong></span><span>Proposed: <strong className="text-ink">{proposed}</strong></span><span>Open questions: <strong className="text-ink">{props.snapshot.memory.openQuestions.filter((item) => !item.resolved).length}</strong></span><span>Criteria: <strong className="text-ink">{props.snapshot.memory.acceptanceCriteria.length}</strong></span></div><p className="mt-4 text-sm leading-relaxed text-ink">{props.progress?.explanation}</p><div className="mt-4 h-2 overflow-hidden rounded bg-canvas"><div className="h-full rounded bg-forest" style={{ width: `${props.progress?.score ?? 0}%` }} /></div><p className="mt-2 font-mono text-xs text-muted">{props.progress?.score ?? 0}% · {props.progress?.level}</p>{props.progress?.criticalGaps.length ? <ul className="mt-4 space-y-2 text-xs text-muted">{props.progress.criticalGaps.map((gap) => <li key={gap}>Still exploring: {gap}</li>)}</ul> : null}</div><div className="rounded border border-line bg-paper p-5"><p className="font-mono text-xs uppercase tracking-wide text-muted">Next stage</p><div className="mt-3 flex flex-col gap-2"><Button variant="secondary" onClick={props.onArchitecture} disabled={props.busy}>Show architecture</Button><Button variant="secondary" onClick={props.onSrs} disabled={props.busy}>Draft specification</Button></div></div></aside></div>;
}

function diagramEdges(source: string): Array<[string, string]> {
  return source.split("\n").flatMap((line): Array<[string, string]> => {
    const match = line.match(/^\s*([\w -]{1,80})\s*-->\s*([\w -]{1,80})\s*$/);
    return match ? [[match[1].trim(), match[2].trim()]] : [];
  });
}

export function ArchitectureDiagram({ source }: { source: string }) {
  const edges = diagramEdges(source);
  const nodes = [...new Set(edges.flat())];
  const width = 720;
  const height = Math.max(180, nodes.length * 100);
  const positions = new Map(nodes.map((node, index) => [node, { x: index % 2 ? 440 : 40, y: 35 + Math.floor(index / 2) * 120 }]));
  return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="System architecture diagram" className="h-auto w-full rounded border border-line bg-canvas">
    <defs><marker id="architecture-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
    {edges.map(([from, to], index) => { const a = positions.get(from); const b = positions.get(to); return a && b ? <line key={`${from}-${to}-${index}`} x1={a.x + 110} y1={a.y + 28} x2={b.x + 110} y2={b.y + 28} stroke="currentColor" strokeWidth="2" markerEnd="url(#architecture-arrow)" /> : null; })}
    {nodes.map((node) => { const position = positions.get(node)!; return <g key={node}><rect x={position.x} y={position.y} width="220" height="56" rx="6" fill="white" stroke="currentColor" /><text x={position.x + 110} y={position.y + 34} textAnchor="middle" className="fill-ink text-sm">{node}</text></g>; })}
  </svg>;
}

export function ArchitectureCard(props: { architecture: ArchitectureVersion; projectTitle: string; busy: boolean; onBack: () => void; onSrs: () => void; error: string | null }) {
  return <div className="mx-auto max-w-[860px] rounded border border-line bg-paper p-6 sm:p-8"><p className="font-mono text-xs uppercase tracking-wide text-muted">Architecture v{props.architecture.version}</p><h1 className="display mt-1 text-3xl text-ink">{props.projectTitle}</h1><p className="mt-4 text-sm leading-relaxed text-ink">{props.architecture.summary}</p><p className="mt-2 text-xs text-muted">{props.architecture.reasonForChange}</p><div className="mt-7"><ArchitectureDiagram source={props.architecture.diagramSource} /></div>{props.error ? <p role="alert" className="mt-4 text-sm text-danger">{props.error}</p> : null}<div className="mt-7 flex flex-wrap gap-3"><Button variant="secondary" onClick={props.onBack} disabled={props.busy}>Back to interview</Button><Button onClick={props.onSrs} disabled={props.busy}>{props.busy ? "Drafting..." : "Draft specification"}</Button></div></div>;
}

function UsageCard({ usage }: { usage: ProjectUsageSummary }) {
  const percent = usage.budget > 0 ? Math.min(100, (usage.used / usage.budget) * 100) : 0;
  const format = (value: number) => value.toFixed(2);
  return <div className="rounded border border-line bg-paper p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Project CREDIT balance</p><p className="mt-2 text-2xl font-medium text-ink">{format(usage.remaining)}</p><p className="text-xs text-muted">remaining of {format(usage.budget)} budget</p></div><span className="font-mono text-xs text-muted">{format(usage.used)} used</span></div><div className="mt-4 h-2 overflow-hidden rounded bg-canvas"><div className="h-full rounded bg-credit" style={{ width: `${percent}%` }} /></div><p className="mt-3 text-xs leading-relaxed text-muted">Promgent usage is tracked from recorded inference tokens. {usage.estimated ? "Some costs are estimated from the saved model rates." : "Costs are provider-reported."}</p><a href={ORBIO_ACCOUNT_URL} target="_blank" rel={EXTERNAL_LINK_REL} className="mt-2 inline-block text-xs text-forest hover:underline">View actual Orbio account balance</a></div>;
}

export function SrsCard(props: { snapshot: GuidedProjectSnapshot; srs: SrsDocument; busy: boolean; onBack: () => void; onApprove: () => void; onPlan: () => void; error: string | null }) {
  const ready = props.snapshot.memory.completeness.level === "ready";
  return <div className="mx-auto max-w-[820px] rounded border border-line bg-paper p-6 sm:p-8"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Specification draft v{props.srs.version}</p><h1 className="display mt-1 text-3xl text-ink">{props.snapshot.project.title}</h1></div><span className="rounded bg-canvas px-2 py-1 font-mono text-xs text-muted">{props.srs.status}</span></div>{!ready ? <div role="alert" className="mt-5 rounded border border-line bg-canvas p-4"><p className="text-sm font-medium text-ink">This specification is incomplete and cannot be approved yet.</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">{props.snapshot.memory.completeness.criticalGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></div> : null}<pre className="mt-7 max-h-[65vh] overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink">{props.srs.content}</pre>{props.error ? <p role="alert" className="mt-4 text-sm text-danger">{props.error}</p> : null}<div className="mt-7 flex flex-wrap gap-3"><Button onClick={props.onBack} disabled={props.busy}>Continue interview</Button>{props.srs.status !== "approved" ? <Button onClick={props.onApprove} disabled={props.busy || !ready}>Approve specification</Button> : <Button onClick={props.onPlan} disabled={props.busy}>{props.busy ? "Planning..." : "Generate implementation prompt"}</Button>}<Button variant="secondary" onClick={() => navigator.clipboard?.writeText(props.srs.content)}>Copy specification</Button></div></div>;
}

function ImplementationCard(props: { snapshot: GuidedProjectSnapshot; plan: NonNullable<GuidedProjectSnapshot["implementationPlan"]>; busy: boolean; error: string | null; onBack: () => void; onIteration: () => void }) {
  return <div className="mx-auto max-w-[900px] rounded border border-line bg-paper p-6 sm:p-8"><p className="font-mono text-xs uppercase tracking-wide text-muted">Implementation handoff</p><h1 className="display mt-1 text-3xl text-ink">{props.snapshot.project.title}</h1><p className="mt-3 text-sm leading-relaxed text-muted">The existing Promgent planning engine turned this project's approved specification into an external implementation prompt. Promgent does not execute the application.</p><div className="mt-6 rounded bg-canvas p-4"><div className="flex flex-wrap justify-between gap-3 text-sm"><span>Model: <strong>{props.plan.modelId}</strong></span><span>Project budget: <strong>{props.snapshot.project.creditBudget} CREDIT</strong></span></div><p className="mt-2 text-xs text-muted">Planning estimate: {props.plan.cost.minimum}–{props.plan.cost.maximum} CREDIT</p></div><pre className="mt-6 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-line bg-paper p-4 font-sans text-sm leading-relaxed text-ink">{props.plan.prompt}</pre>{props.error ? <p role="alert" className="mt-4 text-sm text-danger">{props.error}</p> : null}<div className="mt-6 flex flex-wrap gap-3"><Button onClick={() => navigator.clipboard?.writeText(props.plan.prompt)}>Copy implementation prompt</Button><Button variant="secondary" onClick={props.onIteration}>Review implementation</Button><Button variant="secondary" onClick={props.onBack} disabled={props.busy}>Back to specification</Button></div></div>;
}

/** Backwards-compatible import name for legacy callers; the UI has one project flow. */
export const GuidedProjectWorkspace = ProjectWorkspace;
