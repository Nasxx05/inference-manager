"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Coins, Menu, Plus, Settings2, Trash2, X } from "lucide-react";
import { PromgentLogo } from "@/components/PromgentLogo";
import {
  completePasswordReset,
  connectOrbio,
  createProject,
  deleteProject,
  getOrbioBalance,
  getOrbioStatus,
  getSession,
  listProjects,
  loadProject,
  requestPasswordReset,
  sendConversation,
  signIn,
  signOut,
  signUp,
  type GuidedUser,
  type OrbioStatus,
} from "@/lib/guidedApi";
import type { ProjectAction, ProjectArtifact } from "@/types/conversation";
import type { GuidedProjectSnapshot, ProjectRecord } from "@/types/project";
import { ArtifactCard } from "./ArtifactCard";
import { AssistantMessageContent } from "./AssistantMessageContent";
import { IntakeVoiceButton, ProjectComposer } from "./ProjectComposer";
import { ProjectContextPanel } from "./ProjectContextPanel";

const ACTIVE_PROJECT_KEY = "promgent.activeProjectId";

function generationLabel(message: string): string {
  if (/prompt/i.test(message)) return "Preparing the technical blueprint, architecture, and implementation prompt…";
  if (/architecture|diagram/i.test(message)) return "Designing the project architecture…";
  return "Promgent is thinking…";
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: GuidedUser) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice(null);
    try {
      if (mode === "signin") onAuthenticated((await signIn(email, password)).user);
      else {
        const result = await signUp(email, password);
        if (result.authenticated && result.user) onAuthenticated(result.user);
        else setNotice("Check your email to confirm your account, then sign in.");
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Authentication failed."); }
    finally { setBusy(false); }
  }

  async function reset() {
    if (!email) { setNotice("Enter your email address first."); return; }
    setBusy(true);
    try { setNotice((await requestPasswordReset(email)).message); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not request a reset."); }
    finally { setBusy(false); }
  }

  return (
    <main className="grid min-h-screen place-items-center px-5 py-12">
      <div className="w-full max-w-md">
        <div className="mb-9 flex items-center gap-3"><PromgentLogo size={38} priority /><span className="font-mono text-sm font-medium">Promgent</span></div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-forest">Build with clarity</p>
        <h1 className="display mt-3 text-4xl">Your senior engineer, in one conversation.</h1>
        <p className="mt-4 text-sm leading-6 text-muted">Shape the idea, make technical decisions, create build-ready artifacts, and improve the result without losing context.</p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <label className="block text-xs font-medium">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-2 w-full rounded-md border border-line bg-paper px-3 py-3 text-sm outline-none focus:border-forest" /></label>
          <label className="block text-xs font-medium">Password<input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 w-full rounded-md border border-line bg-paper px-3 py-3 text-sm outline-none focus:border-forest" /></label>
          {notice ? <p className="rounded-md bg-credit-light px-3 py-2 text-xs leading-5 text-ink">{notice}</p> : null}
          <button disabled={busy} className="w-full rounded-md bg-forest px-4 py-3 text-sm font-medium text-white hover:bg-forest-dark disabled:opacity-50">{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
        </form>
        <div className="mt-4 flex justify-between text-xs text-muted">
          <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="hover:text-ink">{mode === "signin" ? "Create an account" : "Already have an account"}</button>
          {mode === "signin" ? <button type="button" onClick={() => void reset()} className="hover:text-ink">Forgot password?</button> : null}
        </div>
      </div>
    </main>
  );
}

function RecoveryScreen({ accessToken, refreshToken, onComplete }: { accessToken: string; refreshToken: string; onComplete: (user: GuidedUser) => void }) {
  const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  return <main className="grid min-h-screen place-items-center px-5"><form className="w-full max-w-md" onSubmit={async (event) => { event.preventDefault(); if (password !== confirmation) { setError("The passwords do not match."); return; } setBusy(true); setError(null); try { onComplete((await completePasswordReset(accessToken, refreshToken, password)).user); } catch (caught) { setError(caught instanceof Error ? caught.message : "The reset link is invalid or expired."); } finally { setBusy(false); } }}>
    <div className="mb-8 flex items-center gap-3"><PromgentLogo size={36} /><span className="font-mono text-sm font-medium">Promgent</span></div>
    <h1 className="display text-4xl">Choose a new password</h1><p className="mt-3 text-sm text-muted">Use at least eight characters.</p>
    <input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New password" className="mt-7 w-full rounded-md border border-line bg-paper px-3 py-3 text-sm outline-none focus:border-forest" />
    <input type="password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Confirm password" className="mt-3 w-full rounded-md border border-line bg-paper px-3 py-3 text-sm outline-none focus:border-forest" />
    {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}<button disabled={busy} className="mt-5 w-full rounded-md bg-forest px-4 py-3 text-sm text-white disabled:opacity-50">{busy ? "Updating…" : "Update password"}</button>
  </form></main>;
}

function OrbioDialog({ status, onClose, onConnected }: { status: OrbioStatus | null; onClose: () => void; onConnected: (status: OrbioStatus) => void }) {
  const [key, setKey] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  return <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 px-5" role="dialog" aria-modal="true">
    <div className="w-full max-w-md rounded-xl bg-paper p-6 shadow-2xl">
      <div className="flex items-center justify-between"><h2 className="text-base font-semibold">Orbio connection</h2><button onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button></div>
      {status?.connected && status.status === "active" ? <><p className="mt-4 text-sm text-muted">Connected securely. Promgent never sends your key to the browser after it is saved.</p><p className="mt-3 font-mono text-xs text-forest">Active · {status.keyFingerprint ?? "verified"}</p></> : <>
        <p className="mt-4 text-sm leading-6 text-muted">Add your Orbio API key to let Promgent choose the lowest-cost capable model for each task.</p>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Orbio API key" autoComplete="off" className="mt-4 w-full rounded-md border border-line px-3 py-3 text-sm outline-none focus:border-forest" />
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
        <button disabled={busy || !key.trim()} onClick={async () => { setBusy(true); setError(null); try { onConnected(await connectOrbio(key)); setKey(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "Connection failed."); } finally { setBusy(false); } }} className="mt-4 w-full rounded-md bg-forest px-4 py-3 text-sm text-white disabled:opacity-40">{busy ? "Verifying…" : "Connect Orbio"}</button>
      </>}
    </div>
  </div>;
}

function NewProject({ connected, onConnect, onCreated }: { connected: boolean; onConnect: () => void; onCreated: (id: string) => void }) {
  const [description, setDescription] = useState(""); const [url, setUrl] = useState(""); const [image, setImage] = useState<File | null>(null); const [budget, setBudget] = useState("10"); const [advanced, setAdvanced] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!connected) { onConnect(); return; } setBusy(true); setError(null); try { const result = await createProject({ description, modelId: "auto", planningDepth: "balanced", budget: Number(budget), references: url.trim() ? [{ type: "website", source: url.trim(), metadata: {} }] : [], image }); onCreated(result.project.id); } catch (caught) { setError(caught instanceof Error ? caught.message : "The project could not be created."); } finally { setBusy(false); } }
  return <main className="mx-auto flex min-h-[calc(100vh-64px)] w-full max-w-3xl flex-col justify-center px-5 py-14">
    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-forest">Start a project</p>
    <h1 className="display mt-3 text-4xl sm:text-5xl">What do you want to build?</h1>
    <p className="mt-4 max-w-xl text-sm leading-6 text-muted">Describe it in your own words. Promgent will help you clarify it and keep the important context organized as you talk.</p>
    <form onSubmit={submit} className="mt-8">
      <textarea required minLength={10} maxLength={8000} rows={7} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="For example: I want a simple booking app for independent barbers…" className="w-full resize-y rounded-xl border border-lineStrong bg-paper p-4 text-base leading-7 outline-none focus:border-forest" />
      <div className="mt-3"><IntakeVoiceButton disabled={busy} onTranscript={(text) => setDescription((current) => current ? `${current.trim()} ${text}` : text)} /></div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Optional website or GitHub URL" className="rounded-md border border-line bg-paper px-3 py-2.5 text-sm outline-none focus:border-forest" />
        <label className="rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-muted"><span>{image?.name ?? "Optional reference image"}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImage(e.target.files?.[0] ?? null)} className="sr-only" /></label>
      </div>
      <button type="button" onClick={() => setAdvanced(!advanced)} className="mt-4 text-xs text-muted hover:text-ink">{advanced ? "Hide" : "Show"} CREDIT limit</button>
      {advanced ? <label className="mt-3 block max-w-xs text-xs text-muted">Project CREDIT limit<input type="number" min="0.01" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} className="mt-2 w-full rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-forest" /></label> : null}
      {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}
      {!connected ? <p className="mt-4 rounded-md bg-credit-light px-3 py-2 text-xs">Connect Orbio once before starting. Your key is encrypted on the server.</p> : null}
      <button disabled={busy || !description.trim()} className="mt-6 rounded-md bg-forest px-6 py-3 text-sm font-medium text-white hover:bg-forest-dark disabled:opacity-40">{busy ? "Starting the conversation…" : connected ? "Start conversation" : "Connect Orbio to continue"}</button>
    </form>
  </main>;
}

export function ProjectWorkspace() {
  const [user, setUser] = useState<GuidedUser | null>(null); const [loading, setLoading] = useState(true); const [recovery, setRecovery] = useState<{ accessToken: string; refreshToken: string } | null>(null); const [projects, setProjects] = useState<ProjectRecord[]>([]); const [snapshot, setSnapshot] = useState<GuidedProjectSnapshot | null>(null); const [orbio, setOrbio] = useState<OrbioStatus | null>(null); const [showOrbio, setShowOrbio] = useState(false); const [creating, setCreating] = useState(false); const [sidebar, setSidebar] = useState(false); const [contextOpen, setContextOpen] = useState(false); const [message, setMessage] = useState(""); const [messageImage, setMessageImage] = useState<File | null>(null); const [source, setSource] = useState<"text" | "voice_transcript">("text"); const [sending, setSending] = useState(false); const [error, setError] = useState<string | null>(null); const [projectListError, setProjectListError] = useState<string | null>(null); const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null); const [actions, setActions] = useState<ProjectAction[]>([]); const endRef = useRef<HTMLDivElement>(null);

  async function refreshProjects(openId?: string | null) { const next = await listProjects(); setProjects(next); const id = openId ?? window.localStorage.getItem(ACTIVE_PROJECT_KEY); if (id && next.some((item) => item.id === id)) { setSnapshot(await loadProject(id)); setCreating(false); } else { setSnapshot(null); setCreating(next.length === 0); } }
  async function syncOrbio() { const status = await getOrbioStatus(); setOrbio(status); if (status.connected && status.status === "active") void getOrbioBalance().then((balance) => setOrbio((current) => current ? { ...current, balance } : current)).catch(() => undefined); }
  useEffect(() => { void (async () => { try { const hash = new URLSearchParams(window.location.hash.replace(/^#/, "")); if (hash.get("type") === "recovery" && hash.get("access_token")) { setRecovery({ accessToken: hash.get("access_token") ?? "", refreshToken: hash.get("refresh_token") ?? "" }); window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`); return; } const session = await getSession(); if (session.authenticated && session.user) { setUser(session.user); await Promise.all([refreshProjects(), syncOrbio()]); } } finally { setLoading(false); } })(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [snapshot?.messages.length, sending]);
  const artifacts = snapshot?.artifacts ?? [];
  const artifactById = useMemo(() => new Map(artifacts.map((item) => [item.id, item])), [artifacts]);

  async function open(id: string) { setLoading(true); setError(null); setProjectListError(null); try { const loaded = await loadProject(id); setSnapshot(loaded); setCreating(false); setSidebar(false); window.localStorage.setItem(ACTIVE_PROJECT_KEY, id); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open the project."); } finally { setLoading(false); } }
  async function removeProject(project: ProjectRecord) {
    if (!window.confirm(`Delete “${project.title}” and all of its saved conversation, memory, and artifacts? This cannot be undone.`)) return;
    setDeletingProjectId(project.id); setProjectListError(null);
    try {
      await deleteProject(project.id);
      const remaining = projects.filter((item) => item.id !== project.id);
      setProjects(remaining);
      if (window.localStorage.getItem(ACTIVE_PROJECT_KEY) === project.id) window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
      if (snapshot?.project.id === project.id) {
        setSnapshot(null); setActions([]);
        const next = remaining[0];
        if (next) {
          const loaded = await loadProject(next.id);
          setSnapshot(loaded); setCreating(false); setSidebar(false);
          window.localStorage.setItem(ACTIVE_PROJECT_KEY, next.id);
        } else {
          setCreating(true); setSidebar(false);
        }
      }
    } catch (caught) {
      setProjectListError(caught instanceof Error ? caught.message : "Could not delete the project.");
    } finally {
      setDeletingProjectId(null);
    }
  }
  async function submitMessage(contentOverride?: string) { const content = (contentOverride ?? message).trim(); if (!snapshot || !content || sending) return; const projectId = snapshot.project.id; setSending(true); setError(null); try { const result = await sendConversation(projectId, content, contentOverride ? "text" : source, contentOverride ? null : messageImage); const updatedAt = new Date().toISOString(); setSnapshot((current) => current ? { ...current, project: { ...current.project, phase: result.memory.projectPhase, nextRecommendedAction: result.memory.nextRecommendedAction, updatedAt }, memory: result.memory, interview: result.interview, messages: [...current.messages, result.userMessage, result.assistantMessage], artifacts: [...(current.artifacts ?? []), ...result.artifacts.filter((artifact) => !(current.artifacts ?? []).some((old) => old.id === artifact.id))], usage: result.usage ?? current.usage } : current); setProjects((current) => current.map((project) => project.id === projectId ? { ...project, phase: result.memory.projectPhase, nextRecommendedAction: result.memory.nextRecommendedAction, updatedAt } : project)); setActions(result.actions); setMessage(""); setMessageImage(null); setSource("text"); void getOrbioBalance().then((balance) => setOrbio((current) => current ? { ...current, balance } : current)).catch(() => undefined); } catch (caught) { setError(caught instanceof Error ? caught.message : "Promgent could not complete that turn. No project state was changed."); } finally { setSending(false); } }

  if (loading && !user) return <div className="grid min-h-screen place-items-center text-sm text-muted">Loading Promgent…</div>;
  if (recovery) return <RecoveryScreen {...recovery} onComplete={(next) => { setRecovery(null); setUser(next); setLoading(true); void Promise.all([refreshProjects(), syncOrbio()]).finally(() => setLoading(false)); }} />;
  if (!user) return <AuthScreen onAuthenticated={(next) => { setUser(next); setLoading(true); void Promise.all([refreshProjects(), syncOrbio()]).finally(() => setLoading(false)); }} />;

  const connected = Boolean(orbio?.connected && orbio.status === "active");
  return <div className="h-screen overflow-hidden bg-canvas">
    <header className="z-30 flex h-16 items-center justify-between border-b border-line bg-canvas/95 px-4 backdrop-blur sm:px-5">
      <div className="flex items-center gap-3"><button className="lg:hidden" onClick={() => setSidebar(true)} aria-label="Open projects"><Menu className="h-5 w-5" /></button><PromgentLogo size={30} priority /><span className="font-mono text-sm font-medium">Promgent</span>{snapshot ? <><span className="text-lineStrong">/</span><span className="max-w-[180px] truncate text-sm">{snapshot.project.title}</span></> : null}</div>
      <div className="flex items-center gap-2">{snapshot ? <span className="hidden items-center gap-1.5 rounded-full border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted sm:inline-flex" title="Total CREDIT used by this project's engineering conversation"><Coins className="h-3 w-3" />{snapshot.usage.used.toFixed(3)} used</span> : null}<button onClick={() => setShowOrbio(true)} className={`rounded-full px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide ${connected ? "bg-forest-light text-forest" : "bg-credit-light text-credit"}`}>{connected ? `${orbio?.balance ? orbio.balance.available.toFixed(2) : "Loading…"} CREDIT` : "Connect Orbio"}</button>{snapshot ? <button onClick={() => setContextOpen(true)} className="rounded-md border border-line p-2 lg:hidden" aria-label="Project context"><Settings2 className="h-4 w-4" /></button> : null}<button onClick={() => void signOut().then(() => { window.localStorage.removeItem(ACTIVE_PROJECT_KEY); setUser(null); setSnapshot(null); })} className="hidden text-xs text-muted hover:text-ink sm:block">Sign out</button></div>
    </header>
    <div className="grid h-[calc(100vh-64px)] min-h-0 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_300px]">
      <aside className={`${sidebar ? "fixed inset-y-0 left-0 z-50 block w-[280px] shadow-xl" : "hidden"} overflow-y-auto border-r border-line bg-paper p-4 lg:static lg:block lg:h-full lg:w-auto lg:shadow-none`}>
        <div className="flex items-center justify-between lg:hidden"><span className="text-sm font-medium">Projects</span><button onClick={() => setSidebar(false)}><X className="h-4 w-4" /></button></div>
        <button onClick={() => { setCreating(true); setSnapshot(null); setProjectListError(null); setSidebar(false); }} className="mt-4 flex w-full items-center gap-2 rounded-md border border-line px-3 py-2.5 text-sm hover:border-lineStrong lg:mt-0"><Plus className="h-4 w-4" /> New project</button>
        <p className="mb-2 mt-6 font-mono text-[10px] uppercase tracking-[0.15em] text-muted">Your projects</p>
        <nav className="space-y-1">{projects.map((project) => <div key={project.id} className={`group flex items-start rounded-md ${snapshot?.project.id === project.id ? "bg-forest-light text-forest" : "text-muted hover:bg-canvas hover:text-ink"}`}><button onClick={() => void open(project.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left text-sm"><span className="block truncate">{project.title}</span><span className="mt-1 block font-mono text-[9px] uppercase opacity-70">{(project.phase ?? "exploring").replaceAll("_", " ")}</span>{project.nextRecommendedAction?.label ? <span className="mt-1 block truncate text-[10px] opacity-70">Next: {project.nextRecommendedAction.label}</span> : null}<span className="mt-1 block text-[9px] opacity-50">Updated {new Date(project.updatedAt).toLocaleDateString()}</span></button><button type="button" disabled={deletingProjectId === project.id} onClick={() => void removeProject(project)} aria-label={`Delete ${project.title}`} title={`Delete ${project.title}`} className="m-1.5 shrink-0 rounded p-1.5 text-muted opacity-60 transition hover:bg-danger-light hover:text-danger focus:opacity-100 disabled:cursor-wait disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></div>)}</nav>
        {projectListError ? <p className="mt-3 rounded-md bg-danger-light px-3 py-2 text-xs leading-5 text-danger">{projectListError}</p> : null}
      </aside>

      {creating || !snapshot ? <div className="h-full overflow-y-auto"><NewProject connected={connected} onConnect={() => setShowOrbio(true)} onCreated={(id) => void refreshProjects(id)} /></div> : <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-3xl px-5 pb-12 pt-10 sm:px-8">
          <div className="mb-10"><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-forest">Project conversation</p><h1 className="display mt-2 text-3xl">{snapshot.project.title}</h1></div>
          <div className="space-y-8">{snapshot.messages.map((item) => <article key={item.id} className={item.role === "user" ? "ml-auto max-w-[85%] rounded-xl bg-forest-light px-4 py-3" : "max-w-[95%]"}>
            <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{item.role === "user" ? "You" : "Promgent"}</p>
            {item.role === "assistant" ? <AssistantMessageContent content={item.content} /> : <div className="whitespace-pre-wrap text-sm leading-7">{item.content}</div>}
            {item.role === "assistant" && item.modelRoute?.usage ? <p className="mt-3 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-muted" title={`${item.modelRoute.usage.inputTokens ?? 0} input tokens · ${item.modelRoute.usage.outputTokens ?? 0} output tokens`}><Coins className="h-3 w-3" />This turn: {item.modelRoute.usage.cost.toFixed(4)} CREDIT{item.modelRoute.usage.estimated ? " estimated" : ""}</p> : null}
            {item.artifactIds?.map((id) => artifactById.get(id)).filter((artifact): artifact is ProjectArtifact => Boolean(artifact)).map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
          </article>)}</div>
          {sending ? <div className="mt-8 flex items-center gap-3 text-sm text-muted"><span className="flex gap-1"><i className="pg-mark h-1.5 w-1.5" /><i className="pg-mark pg-mark-2 h-1.5 w-1.5" /><i className="pg-mark pg-mark-3 h-1.5 w-1.5" /></span> {generationLabel(message)}</div> : null}
          {actions.length ? <div className="mt-8 flex flex-wrap gap-2">{actions.filter((action) => action.type !== "view_artifact").slice(0, 3).map((action) => <button key={action.id} disabled={sending} onClick={() => ["generate_prompt", "generate_architecture", "estimate_credit"].includes(action.type) ? void submitMessage(action.label) : setMessage(action.label)} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:border-lineStrong hover:text-ink disabled:opacity-40">{action.label}</button>)}</div> : null}
          {error ? <p className="mt-8 rounded-md bg-danger-light px-4 py-3 text-sm text-danger">{error}</p> : null}<div ref={endRef} />
        </div></div>
        <div className="shrink-0 border-t border-line bg-canvas/95 px-4 py-4 backdrop-blur"><div className="mx-auto max-w-3xl"><ProjectComposer value={message} onChange={(value, nextSource = "text") => { setMessage(value); setSource(nextSource); }} image={messageImage} onImageChange={setMessageImage} onSubmit={() => void submitMessage()} disabled={sending || !connected} />{!connected ? <button onClick={() => setShowOrbio(true)} className="mt-2 text-xs text-credit">Connect Orbio to continue the conversation.</button> : null}</div></div>
      </main>}
      {snapshot ? <div className="hidden h-full min-h-0 xl:block"><ProjectContextPanel snapshot={snapshot} balance={orbio?.balance} /></div> : null}
    </div>
    {sidebar ? <button className="fixed inset-0 z-40 bg-ink/20 lg:hidden" aria-label="Close projects" onClick={() => setSidebar(false)} /> : null}
    {contextOpen && snapshot ? <div className="fixed inset-0 z-50 bg-ink/30 xl:hidden"><div className="absolute inset-y-0 right-0 w-[min(90vw,340px)] bg-paper"><button onClick={() => setContextOpen(false)} className="absolute right-4 top-4 z-10"><X className="h-4 w-4" /></button><ProjectContextPanel snapshot={snapshot} balance={orbio?.balance} /></div></div> : null}
    {showOrbio ? <OrbioDialog status={orbio} onClose={() => setShowOrbio(false)} onConnected={(status) => { setOrbio(status); setShowOrbio(false); }} /> : null}
  </div>;
}
