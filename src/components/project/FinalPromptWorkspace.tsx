"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Clipboard, FileCode2, Github, Loader2, RefreshCw } from "lucide-react";
import { PromgentLogo } from "@/components/PromgentLogo";
import { getSession, loadProject, sendConversation } from "@/lib/guidedApi";
import type { ProjectArtifact } from "@/types/conversation";
import type { GuidedProjectSnapshot } from "@/types/project";
import { AssistantMessageContent } from "./AssistantMessageContent";

const ACTIVE_PROJECT_KEY = "promgent.activeProjectId";
const PROMPT_TYPES = new Set(["implementation_prompt", "correction_prompt", "enhancement_prompt"]);

function newest(artifacts: ProjectArtifact[], predicate: (artifact: ProjectArtifact) => boolean) {
  return artifacts.filter(predicate).sort((left, right) => right.version - left.version)[0];
}

export function FinalPromptWorkspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<GuidedProjectSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewInput, setReviewInput] = useState("");
  const [fileEvidence, setFileEvidence] = useState("");
  const [reviewReply, setReviewReply] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const session = await getSession();
        if (!session.authenticated) { router.replace("/"); return; }
        window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
        setSnapshot(await loadProject(projectId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "This project could not be loaded.");
      } finally { setLoading(false); }
    })();
  }, [projectId, router]);

  const finalPrompt = useMemo(() => newest(snapshot?.artifacts ?? [], (artifact) => PROMPT_TYPES.has(artifact.type)), [snapshot]);
  const latestReview = useMemo(() => newest(snapshot?.artifacts ?? [], (artifact) => artifact.type === "repository_review"), [snapshot]);

  function mergeResult(result: Awaited<ReturnType<typeof sendConversation>>) {
    setSnapshot((current) => current ? {
      ...current,
      memory: result.memory,
      interview: result.interview,
      messages: [...current.messages, result.userMessage, result.assistantMessage],
      artifacts: [...(current.artifacts ?? []), ...result.artifacts.filter((artifact) => !(current.artifacts ?? []).some((existing) => existing.id === artifact.id))],
      usage: result.usage ?? current.usage,
    } : current);
    return result;
  }

  async function generatePrompt() {
    if (!snapshot || busy) return;
    setBusy(true); setError(null);
    try {
      mergeResult(await sendConversation(projectId, "Generate the final implementation prompt from the current project brief. Include all confirmed scope, explicit constraints, acceptance behavior, architecture responsibilities, implementation phases, and tests. Do not add unconfirmed features."));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The final prompt could not be generated."); }
    finally { setBusy(false); }
  }

  async function reviewBuild() {
    const evidence = [reviewInput.trim(), fileEvidence].filter(Boolean).join("\n\n").slice(0, 7200);
    if (!snapshot || !evidence || busy) return;
    setBusy(true); setError(null); setReviewReply("");
    try {
      const result = mergeResult(await sendConversation(projectId, `Review this implementation against the current project brief. Return a requirement-by-requirement checklist using Done, Partial, or Missing; cite exact file, code, commit, or test evidence for every result; then provide one copyable fix prompt covering all Partial and Missing items. Do not claim runtime evidence that was not supplied.\n\nIMPLEMENTATION EVIDENCE:\n${evidence}`));
      setReviewReply(result.assistantMessage.content);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The implementation review could not be completed."); }
    finally { setBusy(false); }
  }

  async function readFiles(files: FileList | null) {
    if (!files) return;
    const selected = Array.from(files).slice(0, 4);
    const chunks: string[] = [];
    for (const file of selected) {
      if (file.size > 500_000) { setError(`${file.name} is larger than 500 KB. Paste only the relevant code instead.`); continue; }
      chunks.push(`FILE: ${file.name}\n${(await file.text()).slice(0, 5000)}`);
    }
    setFileEvidence(chunks.join("\n\n").slice(0, 6500));
  }

  if (loading) return <main className="grid min-h-screen place-items-center text-sm text-muted">Loading the final prompt…</main>;
  if (!snapshot) return <main className="grid min-h-screen place-items-center px-5"><div className="max-w-md text-center"><p className="text-sm text-danger">{error ?? "Project not found."}</p><Link href="/" className="mt-4 inline-block text-sm text-forest">Return to Promgent</Link></div></main>;

  return <div className="min-h-screen bg-canvas">
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 px-5 py-4 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-3"><PromgentLogo size={30} priority /><div className="min-w-0"><p className="truncate text-sm font-medium">{snapshot.project.title}</p><p className="font-mono text-[9px] uppercase tracking-wider text-muted">Final prompt & review</p></div></div><Link href="/" className="inline-flex items-center gap-2 text-xs text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> Edit brief</Link></div>
    </header>
    <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-xl border border-line bg-paper p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-forest">Build handoff</p><h1 className="display mt-2 text-3xl">Final implementation prompt</h1>{finalPrompt ? <p className="mt-2 text-xs text-muted">Version {finalPrompt.version} · generated {new Date(finalPrompt.updatedAt).toLocaleString()}</p> : <p className="mt-2 text-sm text-muted">Generate a versioned prompt from the live project brief when the interview is ready.</p>}</div><div className="flex gap-2"><button type="button" disabled={busy || !finalPrompt} onClick={async () => { if (!finalPrompt) return; await navigator.clipboard.writeText(finalPrompt.content); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }} className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs disabled:opacity-40">{copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}{copied ? "Copied" : "Copy"}</button><button type="button" disabled={busy} onClick={() => void generatePrompt()} className="inline-flex items-center gap-2 rounded-md bg-forest px-3 py-2 text-xs text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{finalPrompt ? "New version" : "Generate"}</button></div></div>
        <div className="mt-6 max-h-[68vh] overflow-y-auto rounded-lg border border-line bg-canvas p-5">{finalPrompt ? <pre className="whitespace-pre-wrap font-sans text-sm leading-7 text-ink">{finalPrompt.content}</pre> : <p className="py-16 text-center text-sm text-muted">No final prompt has been generated yet.</p>}</div>
        {error ? <p className="mt-4 rounded-md bg-danger-light px-4 py-3 text-sm text-danger">{error}</p> : null}
      </section>

      <aside className="rounded-xl border border-line bg-paper p-5 lg:sticky lg:top-24 lg:self-start">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-forest">Verify the build</p><h2 className="mt-2 text-lg font-semibold">Review implementation</h2><p className="mt-2 text-xs leading-5 text-muted">Paste a public GitHub URL, relevant code, or select small text files. Promgent compares the evidence with the saved brief.</p>
        <div className="mt-5 flex gap-2 text-[10px] text-muted"><span className="inline-flex items-center gap-1 rounded bg-canvas px-2 py-1"><Github className="h-3 w-3" /> GitHub URL</span><span className="inline-flex items-center gap-1 rounded bg-canvas px-2 py-1"><FileCode2 className="h-3 w-3" /> Code files</span></div>
        <textarea rows={8} value={reviewInput} onChange={(event) => setReviewInput(event.target.value)} placeholder="https://github.com/owner/repository\n\nor paste the relevant code and test output…" className="mt-3 w-full resize-y rounded-md border border-line bg-canvas p-3 text-xs leading-5 outline-none focus:border-forest" />
        <label className="mt-3 block cursor-pointer rounded-md border border-dashed border-lineStrong p-3 text-center text-xs text-muted hover:border-forest"><input type="file" multiple accept=".txt,.md,.js,.jsx,.ts,.tsx,.json,.py,.go,.rs,.java,.html,.css,.sql,.yml,.yaml" className="sr-only" onChange={(event) => void readFiles(event.target.files)} />{fileEvidence ? "Files ready — choose again to replace" : "Choose up to 4 text/code files"}</label>
        <button type="button" disabled={busy || (!reviewInput.trim() && !fileEvidence)} onClick={() => void reviewBuild()} className="mt-3 w-full rounded-md bg-ink px-4 py-2.5 text-xs font-medium text-white disabled:opacity-40">{busy ? "Reviewing evidence…" : "Review build"}</button>
        {(reviewReply || latestReview) ? <div className="mt-5 border-t border-line pt-5"><p className="mb-3 font-mono text-[9px] uppercase tracking-wider text-muted">Latest result</p><div className="max-h-[42vh] overflow-y-auto text-xs leading-6"><AssistantMessageContent content={reviewReply || latestReview?.content || ""} /></div></div> : null}
        <div className="mt-5 border-t border-line pt-4"><p className="text-[10px] text-muted">Session CREDIT</p><p className="mt-1 font-mono text-xs">{snapshot.usage.used.toFixed(3)} used · {snapshot.usage.remaining.toFixed(3)} left</p></div>
      </aside>
    </main>
  </div>;
}
