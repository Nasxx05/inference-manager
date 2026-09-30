"use client";

import { ImagePlus, Mic, Send, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import { transcribeAudio } from "@/lib/guidedApi";

export function IntakeVoiceButton({ onTranscript, disabled }: { onTranscript: (text: string) => void; disabled?: boolean }) {
  const recorder = useRef<MediaRecorder | null>(null); const chunks = useRef<Blob[]>([]); const [recording, setRecording] = useState(false); const [transcribing, setTranscribing] = useState(false); const [error, setError] = useState<string | null>(null);
  async function toggle() {
    if (recording) { recorder.current?.stop(); setRecording(false); return; }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const next = new MediaRecorder(stream); chunks.current = [];
      next.ondataavailable = (event) => event.data.size && chunks.current.push(event.data);
      next.onstop = async () => { stream.getTracks().forEach((track) => track.stop()); setTranscribing(true); try { onTranscript(await transcribeAudio(new Blob(chunks.current, { type: next.mimeType || "audio/webm" }))); } catch (caught) { setError(caught instanceof Error ? caught.message : "Voice transcription is unavailable."); } finally { setTranscribing(false); } };
      recorder.current = next; next.start(); setRecording(true);
    } catch { setError("Microphone access was not available."); }
  }
  return <div className="flex items-center gap-2"><button type="button" disabled={disabled || transcribing} onClick={() => void toggle()} className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs ${recording ? "border-danger bg-danger-light text-danger" : "border-line bg-paper text-muted hover:text-ink"}`}>{recording ? <Square className="h-3 w-3 fill-current" /> : <Mic className="h-3.5 w-3.5" />}{recording ? "Stop" : transcribing ? "Transcribing…" : "Describe by voice"}</button>{error ? <span className="max-w-xs text-xs text-danger">{error}</span> : null}</div>;
}

export function ProjectComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  image,
  onImageChange,
}: {
  value: string;
  onChange: (value: string, source?: "text" | "voice_transcript") => void;
  onSubmit: () => void;
  disabled?: boolean;
  image?: File | null;
  onImageChange?: (file: File | null) => void;
}) {
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const next = new MediaRecorder(stream);
      chunks.current = [];
      next.ondataavailable = (event) => event.data.size && chunks.current.push(event.data);
      next.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setTranscribing(true);
        try {
          const transcript = await transcribeAudio(new Blob(chunks.current, { type: next.mimeType || "audio/webm" }));
          onChange(value ? `${value.trim()} ${transcript}` : transcript, "voice_transcript");
        } catch (error) {
          setVoiceError(error instanceof Error ? error.message : "Voice transcription is unavailable.");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = next;
      next.start();
      setRecording(true);
    } catch {
      setVoiceError("Microphone access was not available. You can continue by typing.");
    }
  }

  return (
    <div>
      <div className="rounded-xl border border-lineStrong bg-paper p-2 shadow-[0_12px_35px_rgba(40,35,25,0.06)] focus-within:border-forest">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value, "text")}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (value.trim() && !disabled) onSubmit();
            }
          }}
          rows={3}
          disabled={disabled}
          placeholder="Ask Promgent anything about this project…"
          className="w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-muted/70 disabled:opacity-60"
        />
        {image ? <div className="mx-1 mb-2 flex items-center justify-between rounded-md bg-canvas px-3 py-2 text-xs text-muted"><span className="truncate">Image: {image.name}</span><button type="button" onClick={() => onImageChange?.(null)} aria-label="Remove image"><X className="h-3.5 w-3.5" /></button></div> : null}
        <div className="flex items-center justify-between gap-3 px-1 pb-1">
          <div className="flex items-center gap-2"><button
            type="button"
            onClick={() => void toggleRecording()}
            disabled={disabled || transcribing}
            aria-label={recording ? "Stop recording" : "Record a voice message"}
            className={`grid h-9 w-9 place-items-center rounded-full border transition ${recording ? "border-danger bg-danger-light text-danger" : "border-line text-muted hover:border-lineStrong hover:text-ink"}`}
          >
            {recording ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
          </button>{onImageChange ? <label className="grid h-9 w-9 cursor-pointer place-items-center rounded-full border border-line text-muted hover:border-lineStrong hover:text-ink" aria-label="Attach an image"><ImagePlus className="h-4 w-4" /><input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => onImageChange(event.target.files?.[0] ?? null)} /></label> : null}</div>
          <div className="flex items-center gap-3">
            <span className="hidden text-[11px] text-muted sm:inline">Enter to send · Shift+Enter for a new line</span>
            <button
              type="button"
              onClick={onSubmit}
              disabled={disabled || !value.trim()}
              className="grid h-9 w-9 place-items-center rounded-full bg-forest text-white hover:bg-forest-dark disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      {transcribing ? <p className="mt-2 text-xs text-muted">Transcribing—your text will remain editable before sending.</p> : null}
      {voiceError ? <p className="mt-2 text-xs text-danger">{voiceError}</p> : null}
    </div>
  );
}
