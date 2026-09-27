"use client";

import { useEffect, useRef, useState } from "react";
import type { IterationPrompt, ProjectIteration, ReviewFinding, ProjectSuggestion, SuggestionDiscussionMessage } from "@/types/iteration";
import type { SrsDocument } from "@/types/project";
import { approveIterationChanges, approveSrs, createIteration, decideIterationFinding, decideIterationSuggestion, generateIterationPrompt, getSuggestionDiscussion, listIterations, reviewIteration, sendSuggestionDiscussion, transcribeAudio, updateIterationStatus } from "@/lib/guidedApi";
import { Button } from "./ui";

export function IterationWorkspace({ projectId, projectTitle, onBack }: { projectId: string; projectTitle: string; onBack: () => void }) {
  const [iterations, setIterations] = useState<ProjectIteration[]>([]);
  const [iteration, setIteration] = useState<ProjectIteration | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [feedback, setFeedback] = useState("");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const [updatedSrs, setUpdatedSrs] = useState<SrsDocument | null>(null);
  const [prompt, setPrompt] = useState<IterationPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discussionSuggestion, setDiscussionSuggestion] = useState<ProjectSuggestion | null>(null);
  const [discussionMessages, setDiscussionMessages] = useState<SuggestionDiscussionMessage[]>([]);
  const [discussionInput, setDiscussionInput] = useState("");
  const [screenshotFiles, setScreenshotFiles] = useState<File[]>([]);
  const [forceReview, setForceReview] = useState(false);

  async function refresh() {
    setBusy(true); setError(null);
    try { const result = await listIterations(projectId); setIterations(result); setIteration(result[result.length - 1] ?? null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load iterations."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function begin() {
    setBusy(true); setError(null);
    try { const result = await createIteration(projectId); setIterations((current) => [...current, result]); setIteration(result); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start an iteration."); }
    finally { setBusy(false); }
  }

  async function analyze() {
    if (!iteration) return;
    setBusy(true); setError(null);
    try { setIteration(await reviewIteration(projectId, iteration.id, { repositoryUrl: repositoryUrl || undefined, liveUrl: liveUrl || undefined, text: voiceTranscript ? undefined : feedback || undefined, voiceTranscript: voiceTranscript || undefined, screenshotFiles, forceReview })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The implementation review failed."); }
    finally { setBusy(false); }
  }

  async function toggleRecording() {
    if (recording) { recorder.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("Voice recording is not available in this browser."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const nextRecorder = new MediaRecorder(stream);
      audioChunks.current = [];
      nextRecorder.ondataavailable = (event) => { if (event.data.size) audioChunks.current.push(event.data); };
      nextRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop()); setRecording(false); setTranscribing(true); setError(null);
        try { const transcript = await transcribeAudio(new Blob(audioChunks.current, { type: nextRecorder.mimeType || "audio/webm" })); setFeedback(transcript); setVoiceTranscript(transcript); }
        catch (caught) { setError(caught instanceof Error ? caught.message : "Voice transcription failed."); }
        finally { setTranscribing(false); }
      };
      recorder.current = nextRecorder; nextRecorder.start(); setRecording(true);
    } catch { setError("Microphone access was not granted."); }
  }

  async function decideFinding(item: ReviewFinding, decision: "accept" | "reject" | "defer") {
    if (!iteration) return;
    setBusy(true); setError(null);
    try { setIteration(await decideIterationFinding(projectId, iteration.id, item.id, decision)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save that decision."); }
    finally { setBusy(false); }
  }

  async function decideSuggestion(item: ProjectSuggestion, decision: "accept" | "reject" | "defer" | "discuss") {
    if (!iteration) return;
    setBusy(true); setError(null);
    try {
      const updated = await decideIterationSuggestion(projectId, iteration.id, item.id, decision);
      setIteration(updated);
      if (decision === "discuss") { setDiscussionSuggestion(updated.suggestions.find((suggestion) => suggestion.id === item.id) ?? item); setDiscussionMessages(await getSuggestionDiscussion(projectId, iteration.id, item.id)); }
      if (decision === "accept" && discussionSuggestion?.id === item.id) { setDiscussionSuggestion(null); setDiscussionMessages([]); setDiscussionInput(""); }
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save that decision."); }
    finally { setBusy(false); }
  }

  async function sendDiscussionMessage() {
    if (!iteration || !discussionSuggestion || !discussionInput.trim()) return;
    setBusy(true); setError(null);
    try { const result = await sendSuggestionDiscussion(projectId, iteration.id, discussionSuggestion.id, discussionInput.trim()); setIteration(result.iteration); setDiscussionMessages(result.messages); setDiscussionInput(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not continue the discussion."); }
    finally { setBusy(false); }
  }

  async function approveChanges() {
    if (!iteration) return;
    setBusy(true); setError(null);
    try { const result = await approveIterationChanges(projectId, iteration.id); setIteration(result.iteration); setUpdatedSrs(result.srs ?? null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not apply the approved changes."); }
    finally { setBusy(false); }
  }

  async function approveUpdatedSrs() {
    if (!updatedSrs) return;
    setBusy(true); setError(null);
    try { await approveSrs(projectId, updatedSrs.id); setUpdatedSrs({ ...updatedSrs, status: "approved" }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not approve the updated specification."); }
    finally { setBusy(false); }
  }

  async function makePrompt() {
    if (!iteration) return;
    setBusy(true); setError(null);
    try { const result = await generateIterationPrompt(projectId, iteration.id); setIteration(result.iteration); setPrompt(result.prompt); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not generate the iteration prompt."); }
    finally { setBusy(false); }
  }

  const trace = iteration?.report;
  return <div className="min-h-[70vh]">
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Project engineering workspace</p><h1 className="display mt-1 text-3xl text-ink">{projectTitle}</h1><p className="mt-2 text-sm text-muted">Review the implementation against the approved project state, then decide what should happen next.</p></div><Button variant="secondary" onClick={onBack}>Back to project</Button></div>
    {error ? <p role="alert" className="mt-5 rounded border border-danger/30 bg-paper p-3 text-sm text-danger">{error}</p> : null}
    <div className="mt-6 grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-3"><Button onClick={() => void begin()} disabled={busy} className="w-full">{busy ? "Working..." : "Start new iteration"}</Button><div className="rounded border border-line bg-paper p-3"><p className="font-mono text-xs uppercase tracking-wide text-muted">History</p><div className="mt-3 space-y-1">{iterations.length ? iterations.map((item) => <button key={item.id} type="button" onClick={() => { setIteration(item); setPrompt(item.generatedPrompt ?? null); }} className={`w-full rounded px-3 py-2 text-left text-sm ${iteration?.id === item.id ? "bg-forest text-white" : "text-ink hover:bg-canvas"}`}>Iteration #{item.sequenceNumber}<span className="mt-0.5 block text-xs opacity-75">{item.status}</span></button>) : <p className="text-xs text-muted">No reviews yet.</p>}</div></div></aside>
      <main className="space-y-5">
        {!iteration ? <div className="rounded border border-dashed border-line p-10 text-center text-sm text-muted">Return to this project after an external implementation and start an iteration review.</div> : <>
          <section className="rounded border border-line bg-paper p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Iteration #{iteration.sequenceNumber}</p><h2 className="mt-1 text-xl font-medium text-ink">{iteration.title}</h2></div><span className="rounded bg-canvas px-2 py-1 font-mono text-xs text-muted">{iteration.status}</span></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm text-muted">GitHub repository<input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository" className="mt-2 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink" /></label><label className="text-sm text-muted">Live product URL<input value={liveUrl} onChange={(event) => setLiveUrl(event.target.value)} placeholder="https://your-product.example" className="mt-2 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink" /></label></div><label className="mt-4 block text-sm text-muted">Implementation screenshots (optional)<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => setScreenshotFiles(Array.from(event.target.files ?? []).slice(0, 4))} className="mt-2 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink" /></label>{screenshotFiles.length ? <p className="mt-2 text-xs text-muted">{screenshotFiles.length} screenshot{screenshotFiles.length === 1 ? "" : "s"} will be analyzed by the selected project model.</p> : null}<label className="mt-4 block text-sm text-muted">What changed or what should be improved?<textarea value={feedback} onChange={(event) => { setFeedback(event.target.value); setVoiceTranscript(""); }} rows={5} placeholder="Describe requested changes in your own words..." className="mt-2 w-full resize-y rounded border border-line bg-paper px-3 py-3 text-sm leading-relaxed text-ink" /></label>{voiceTranscript ? <p className="mt-2 text-xs text-muted">Transcript ready. Review it before submitting.</p> : null}<label className="mt-3 flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={forceReview} onChange={(event) => setForceReview(event.target.checked)} /> Force review even if the repository commit is unchanged</label><div className="mt-4 flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void toggleRecording()} disabled={busy || transcribing}>{recording ? "Stop recording" : transcribing ? "Transcribing..." : "Record voice"}</Button><Button onClick={() => void analyze()} disabled={busy || recording || transcribing || (!repositoryUrl.trim() && !liveUrl.trim() && !feedback.trim() && !screenshotFiles.length)}>{busy ? "Analyzing..." : "Analyze implementation"}</Button>{iteration.status === "prompt_ready" ? <Button variant="secondary" onClick={() => void updateIterationStatus(projectId, iteration.id, "implementation_in_progress").then(setIteration)} disabled={busy}>Mark implementation started</Button> : null}</div></section>
          {trace ? <section className="grid gap-3 sm:grid-cols-5">{[["Reviewed", trace.requirementsReviewed], ["Satisfied", trace.satisfied], ["Partial", trace.partial], ["Missing", trace.missing], ["Unverified", trace.cannotVerify]].map(([label, value]) => <div key={String(label)} className="rounded border border-line bg-paper p-4"><p className="font-mono text-xs text-muted">{label}</p><p className="mt-2 text-2xl text-ink">{value}</p></div>)}</section> : null}
          {iteration.repositorySnapshot ? <p className="text-xs text-muted">Reviewed commit: <span className="font-mono">{iteration.repositorySnapshot.commitSha ?? "unavailable"}</span> · {iteration.repositorySnapshot.status}</p> : null}
          {iteration.report?.modelSummary ? <section className="rounded border border-line bg-paper p-5"><p className="font-mono text-xs uppercase tracking-wide text-muted">Review Agent summary</p><p className="mt-3 text-sm leading-relaxed text-ink">{iteration.report.modelSummary}</p></section> : null}
          <TraceabilitySection iteration={iteration} />
          <FindingSection title="Required fixes and technical concerns" items={iteration.findings.filter((item) => item.type === "required_fix" || item.type === "technical_concern")} busy={busy} onDecision={(item, decision) => void decideFinding(item, decision)} />
          <FindingSection title="Your requested changes" items={iteration.findings.filter((item) => item.type === "user_change")} busy={busy} onDecision={(item, decision) => void decideFinding(item, decision)} />
          <section className="rounded border border-line bg-paper p-5"><p className="font-mono text-xs uppercase tracking-wide text-muted">Optional opportunities</p>{iteration.suggestions.length ? <div className="mt-4 space-y-3">{iteration.suggestions.map((item) => <SuggestionCard key={item.id} item={item} busy={busy} onDecision={(decision) => void decideSuggestion(item, decision)} />)}</div> : <p className="mt-3 text-sm text-muted">No optional opportunities were identified from the current project context.</p>}</section>
          {discussionSuggestion ? <DiscussionPanel suggestion={discussionSuggestion} messages={discussionMessages} value={discussionInput} setValue={setDiscussionInput} busy={busy} onSend={() => void sendDiscussionMessage()} onAccept={() => void decideSuggestion(discussionSuggestion, "accept")} onClose={() => { setDiscussionSuggestion(null); setDiscussionMessages([]); setDiscussionInput(""); }} /> : null}
          {iteration.status === "review_ready" || iteration.status === "discussing" ? <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void approveChanges()} disabled={busy}>Apply approved changes</Button><Button variant="secondary" onClick={() => void makePrompt()} disabled={busy}>Generate next prompt</Button></div> : null}
          {updatedSrs ? <section className="rounded border border-line bg-paper p-5"><p className="font-mono text-xs uppercase tracking-wide text-muted">Updated specification v{updatedSrs.version}</p><p className="mt-2 text-sm text-muted">Review this material change before approving it.</p><pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-ink">{updatedSrs.content}</pre><div className="mt-4 flex flex-wrap gap-2"><Button onClick={() => void approveUpdatedSrs()} disabled={busy || updatedSrs.status === "approved"}>{updatedSrs.status === "approved" ? "Specification approved" : "Approve updated specification"}</Button><Button variant="secondary" onClick={() => void makePrompt()} disabled={busy || updatedSrs.status !== "approved"}>Generate next prompt</Button></div></section> : null}
          {prompt ? <section className="rounded border border-line bg-paper p-5"><div className="flex items-center justify-between gap-3"><p className="font-mono text-xs uppercase tracking-wide text-muted">{prompt.kind} prompt</p><Button variant="secondary" onClick={() => navigator.clipboard?.writeText(prompt.prompt)}>Copy</Button></div><pre className="mt-4 max-h-[55vh] overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-ink">{prompt.prompt}</pre></section> : null}
        </>}
      </main>
    </div>
  </div>;
}

function DiscussionPanel(props: { suggestion: ProjectSuggestion; messages: SuggestionDiscussionMessage[]; value: string; setValue: (value: string) => void; busy: boolean; onSend: () => void; onAccept: () => void; onClose: () => void }) {
  return <section className="rounded border border-forest/30 bg-paper p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs uppercase tracking-wide text-muted">Discuss opportunity</p><h3 className="mt-1 font-medium text-ink">{props.suggestion.title}</h3></div><button type="button" onClick={props.onClose} className="text-xs text-muted hover:text-ink">Close</button></div><p className="mt-3 text-sm text-muted">Ask why it helps, explore tradeoffs, or specify constraints. The conversation is saved with this project.</p><div className="mt-4 max-h-72 space-y-3 overflow-auto">{props.messages.length ? props.messages.map((message) => <div key={message.id} className={`rounded p-3 text-sm ${message.role === "user" ? "ml-8 bg-forest text-white" : "mr-8 border border-line bg-canvas text-ink"}`}><p className="font-mono text-[10px] uppercase opacity-70">{message.role === "user" ? "You" : "Promgent"}</p><p className="mt-1 whitespace-pre-wrap leading-relaxed">{message.content}</p></div>) : <p className="text-sm text-muted">Start by asking a question or stating the scope you would accept.</p>}</div><textarea value={props.value} onChange={(event) => props.setValue(event.target.value)} rows={3} placeholder="For example: Use Paystack and support card payments only." className="mt-4 w-full resize-y rounded border border-line bg-paper px-3 py-3 text-sm text-ink" /><div className="mt-3 flex flex-wrap gap-2"><Button onClick={props.onSend} disabled={props.busy || !props.value.trim()}>{props.busy ? "Working..." : "Send"}</Button><Button variant="secondary" onClick={props.onAccept} disabled={props.busy}>Accept clarified scope</Button></div></section>;
}

function TraceabilitySection({ iteration }: { iteration: ProjectIteration }) {
  const evidence = new Map(iteration.evidence.map((item) => [item.id, item]));
  return <section className="rounded border border-line bg-paper p-5"><p className="font-mono text-xs uppercase tracking-wide text-muted">Requirements traceability</p>{iteration.traceability.length ? <div className="mt-4 space-y-4">{iteration.traceability.map((item) => <article key={item.id} className="rounded border border-line bg-canvas p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs text-muted">{item.requirementId}</p><p className="mt-1 font-medium text-ink">{item.requirementDescription}</p></div><span className="rounded bg-paper px-2 py-1 font-mono text-xs uppercase text-muted">{item.status.replaceAll("_", " ")}</span></div><p className="mt-3 text-sm leading-relaxed text-muted">{item.explanation}</p>{item.evidenceIds.length ? <div className="mt-3 text-xs text-muted"><span className="font-medium text-ink">Evidence:</span> {item.evidenceIds.map((id) => evidence.get(id)?.repositoryFile ?? evidence.get(id)?.liveUrl ?? evidence.get(id)?.explanation).filter(Boolean).join(", ")}</div> : null}{item.acceptanceCriteria.length ? <div className="mt-4 space-y-2 border-t border-line pt-3">{item.acceptanceCriteria.map((criterion) => <div key={criterion.criterionId} className="grid gap-1 sm:grid-cols-[110px_minmax(0,1fr)]"><span className="font-mono text-xs uppercase text-muted">{criterion.status.replaceAll("_", " ")}</span><div><p className="text-sm text-ink">{criterion.criterionId} · {criterion.description}</p><p className="mt-0.5 text-xs text-muted">{criterion.explanation}</p></div></div>)}</div> : null}</article>)}</div> : <p className="mt-3 text-sm text-muted">No semantic traceability review is available yet.</p>}</section>;
}

function FindingSection(props: { title: string; items: ReviewFinding[]; busy: boolean; onDecision: (item: ReviewFinding, decision: "accept" | "reject" | "defer") => void }) {
  return <section className="rounded border border-line bg-paper p-5"><p className="font-mono text-xs uppercase tracking-wide text-muted">{props.title}</p>{props.items.length ? <div className="mt-4 space-y-3">{props.items.map((item) => <article key={item.id} className="rounded border border-line bg-canvas p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-ink">{item.title}</p>{item.category ? <p className="mt-1 font-mono text-[10px] uppercase text-muted">{item.category.replaceAll("_", " ")} · {item.confidence} confidence · {item.evidenceIds.length} evidence item{item.evidenceIds.length === 1 ? "" : "s"}</p> : null}<p className="mt-2 text-sm leading-relaxed text-ink">{item.description}</p>{item.plainLanguage ? <p className="mt-2 text-xs leading-relaxed text-muted">{item.plainLanguage}</p> : null}<p className="mt-2 text-xs leading-relaxed text-muted"><span className="font-medium text-ink">Likely impact:</span> {item.impact}</p>{item.recommendedDirection ? <p className="mt-1 text-xs leading-relaxed text-muted"><span className="font-medium text-ink">Direction:</span> {item.recommendedDirection}</p> : null}</div><span className="font-mono text-xs text-muted">{item.status} · {item.severity}</span></div><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={props.busy} onClick={() => props.onDecision(item, "accept")} className="rounded border border-line px-2.5 py-1.5 text-xs text-ink hover:bg-paper">Accept</button><button type="button" disabled={props.busy} onClick={() => props.onDecision(item, "reject")} className="rounded border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-paper">Reject</button><button type="button" disabled={props.busy} onClick={() => props.onDecision(item, "defer")} className="rounded border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-paper">Defer</button></div></article>)}</div> : <p className="mt-3 text-sm text-muted">None identified.</p>}</section>;
}

function SuggestionCard(props: { item: ProjectSuggestion; busy: boolean; onDecision: (decision: "accept" | "reject" | "defer" | "discuss") => void }) {
  return <article className="rounded border border-line bg-canvas p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-ink">{props.item.title}</p><p className="mt-1 text-sm leading-relaxed text-ink">{props.item.description}</p></div><span className="font-mono text-xs text-muted">{props.item.status} · {props.item.implementationImpact} impact</span></div><p className="mt-3 text-xs leading-relaxed text-muted"><span className="font-medium text-ink">Why this may help:</span> {props.item.rationale} {props.item.expectedBenefit}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={props.busy} onClick={() => props.onDecision("accept")} className="rounded border border-line px-2.5 py-1.5 text-xs text-ink hover:bg-paper">Add to project</button><button type="button" disabled={props.busy} onClick={() => props.onDecision("discuss")} className="rounded border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-paper">Discuss</button><button type="button" disabled={props.busy} onClick={() => props.onDecision("reject")} className="rounded border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-paper">Ignore</button></div></article>;
}
