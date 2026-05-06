/**
 * LiveTranscribePage — Voxnap's hero screen.
 *
 * Layout (lg):
 *
 *   ┌──────────────────────────────────────┬──────────────────────┐
 *   │ RecordingHero (mic + meter + chips)  │                      │
 *   │                                      │                      │
 *   │ Transcript stream (full-bleed card)  │   Live AI panel      │
 *   │                                      │                      │
 *   │ Waveform bar                         │                      │
 *   └──────────────────────────────────────┴──────────────────────┘
 *
 * On smaller screens the AI panel collapses to a Tabs-style toggle below
 * the transcript.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Eraser,
  Save,
  Sparkles,
  CircleDot,
  Activity,
} from "lucide-react";
import {
  DEFAULT_MODEL,
  useOnboardingStore,
  useTranscriptionStore,
  type Session,
  type WhisperModelId,
} from "@voxnap/core";


import { MicButton } from "../components/MicButton.js";
import { TranscriptView } from "../components/TranscriptView.js";
import { WaveformBar } from "../components/WaveformBar.js";
import { DeviceSelect } from "../components/DeviceSelect.js";
import { LiveAiPanel } from "../components/LiveAiPanel.js";
import { Button } from "../components/ui/Button.js";
import { Badge } from "../components/ui/Badge.js";
import { Shortcut } from "../components/ui/Shortcut.js";
import { Tabs, TabsList, Tab, TabPanel } from "../components/ui/Tabs.js";
import { useTranscription } from "../hooks/useTranscription.js";
import { useSummarizer } from "../engine/SummarizerProvider.js";
import { useLiveAi } from "../hooks/useLiveAi.js";
import { useSessions } from "../hooks/useSessions.js";
import { useToasts } from "../components/ui/Toast.js";

export interface LiveTranscribePageProps {
  modelId?: WhisperModelId;
  language?: string;
  /** When true, whisper transcribes-and-translates into English. */
  translate?: boolean;
  /** VAD RMS threshold (0..1). Passed to the engine on init. Default 0.012. */
  vadThreshold?: number;
  /** When false, VAD is bypassed and whisper always runs. Default true. */
  vadEnabled?: boolean;
}

export function LiveTranscribePage({
  modelId = DEFAULT_MODEL,
  language = "auto",
  translate = false,
  vadThreshold = 0.012,
  vadEnabled = true,
}: LiveTranscribePageProps) {
  const t = useTranscription();
  const summarizer = useSummarizer();
  const { upsert } = useSessions();
  const { push: toast } = useToasts();
  const lastError = useTranscriptionStore((s) => s.lastError);
  const clearError = useTranscriptionStore((s) => s.setError);

  // Seed the input device from the onboarding store so the user's first
  // recording uses the mic they verified during the welcome wizard.
  const onboardingMic = useOnboardingStore((s) => s.micDeviceId);
  const setOnboardingMic = useOnboardingStore((s) => s.setMicDeviceId);
  const [deviceId, setDeviceIdLocal] = useState<string | undefined>(
    onboardingMic || undefined,
  );

  // Persist the user's runtime mic pick back into the onboarding store
  // (same pattern as language / model). The actual capture device is
  // applied at `engine.start(deviceId)` time — DeviceSelect is disabled
  // while a session is running, so we never need to mid-flight switch.
  const setDeviceId = useCallback(
    (next: string | undefined) => {
      setDeviceIdLocal(next);
      setOnboardingMic(next ?? "");
    },
    [setOnboardingMic],
  );

  const [view, setView] = useState<"transcript" | "ai">("transcript");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Track the last config we applied so we can re-init the engine when the
  // user changes language / model / translate / VAD from anywhere in the UI.
  const lastConfigRef = useRef<{
    modelId: WhisperModelId;
    language: string;
    translate: boolean;
    vadThreshold: number;
    vadEnabled: boolean;
  } | null>(null);

  const startedAtRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  // Surface engine errors as toasts so users get something more useful
  // than the cryptic "Engine error" pill in the sidebar.
  useEffect(() => {
    if (!lastError) return;
    toast({
      title: errorTitleFor(lastError.code),
      description: lastError.message,
      tone: "danger",
      duration: 6000,
    });
    // Clear so re-running into the same error toasts again.
    const id = setTimeout(() => clearError(null), 0);
    return () => clearTimeout(id);
  }, [lastError, toast, clearError]);

  // Initialise the engine on first mount, and re-initialise it any time
  // the user picks a different model / language / translate option from
  // anywhere in the app (Topbar, Settings, command palette, …). Without
  // this, whisper.cpp keeps running with whatever language was passed
  // first — typically the onboarding default of `"auto"` — and the
  // user's later language change is silently ignored.
  useEffect(() => {
    const next = { modelId, language, translate, vadThreshold, vadEnabled };
    const prev = lastConfigRef.current;
    if (
      prev &&
      prev.modelId === next.modelId &&
      prev.language === next.language &&
      prev.translate === next.translate &&
      prev.vadThreshold === next.vadThreshold &&
      prev.vadEnabled === next.vadEnabled
    ) {
      return;
    }

    let cancelled = false;
    const wasRunning = t.engineState === "running";

    (async () => {
      try {
        if (wasRunning) await t.stop();
        await t.init({ modelId, language, translate, vadThreshold, vadEnabled });
        if (!cancelled) lastConfigRef.current = next;
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[voxnap] engine init failed:", err);
        toast({
          title: "Couldn't load the engine",
          description:
            (err as Error)?.message ??
            "See the developer console for details.",
          tone: "danger",
          duration: 6000,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // `t` is a stable hook handle; the engine itself is reused across
    // re-inits so we deliberately exclude it from the dep list to avoid
    // double-initing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, language, translate, vadThreshold, vadEnabled]);


  // Track recording start for the elapsed timer.
  useEffect(() => {
    if (t.engineState === "running") {
      if (!startedAtRef.current) startedAtRef.current = Date.now();
      const id = setInterval(() => forceTick((n) => n + 1), 250);
      return () => clearInterval(id);
    }
    startedAtRef.current = null;
  }, [t.engineState]);

  // Live AI stream
  const ai = useLiveAi(summarizer, t.finals, {
    enabled: true,
    auto: t.engineState === "running",
    debounceMs: 1200,
    minFinals: 2,
  });

  const onCopy = async () => {
    if (!t.fullText) return;
    try {
      await navigator.clipboard.writeText(t.fullText);
      toast({ title: "Copied transcript", tone: "success" });
    } catch {
      toast({ title: "Couldn't access clipboard", tone: "danger" });
    }
  };

  const onClear = () => {
    t.clear();
    ai.reset();
    setSavedAt(null);
  };

  const onSave = async () => {
    if (t.finals.length === 0) {
      toast({ title: "Nothing to save yet", tone: "warning" });
      return;
    }
    const last = t.finals[t.finals.length - 1]!;
    const session: Session = {
      id: `sess_${Math.random().toString(36).slice(2, 10)}`,
      title: ai.tldr || `Session · ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      durationMs: last.endMs,
      language,
      modelId,
      tags: [],
      starred: false,
      speakers: [],
      segments: t.finals,
      summary: ai.summary ?? undefined,
      actionItems: ai.actionItems,
      chapters: ai.chapters,
    };
    await upsert(session);
    setSavedAt(Date.now());
    toast({
      title: "Session saved",
      description: session.title,
      tone: "success",
    });
  };

  const onToggleRecord = () => {
    if (t.engineState === "running") void t.stop();
    else void t.start(deviceId);
  };

  const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : 0;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_360px] lg:p-6">
      {/* Left column */}
      <div className="flex min-h-0 flex-col gap-4">
        <RecordingHero
          state={t.engineState}
          modelId={modelId}
          language={language}
          deviceId={deviceId}
          elapsedMs={elapsed}
          onChangeDevice={setDeviceId}
          recordingDisabled={t.engineState === "loading-model"}
          onToggleRecord={onToggleRecord}
          level={t.level}
          savedAt={savedAt}
          fullText={t.fullText}
          onCopy={onCopy}
          onClear={onClear}
          onSave={onSave}
        />

        {/* Stream + waveform */}
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="lg:hidden">
            <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
              <TabsList>
                <Tab value="transcript">Transcript</Tab>
                <Tab value="ai">
                  Live AI
                  {ai.status === "thinking" && (
                    <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                  )}
                </Tab>
              </TabsList>
              <TabPanel value="transcript" className="min-h-0 flex-1">
                <div className="h-[calc(100vh-22rem)] min-h-[280px]">
                  <TranscriptView finals={t.finals} interim={t.interim} />
                </div>
              </TabPanel>
              <TabPanel value="ai" className="min-h-0 flex-1">
                <div className="h-[calc(100vh-22rem)] min-h-[280px]">
                  <LiveAiPanel
                    status={ai.status}
                    tldr={ai.tldr}
                    bullets={ai.bullets}
                    decisions={ai.decisions}
                    questions={ai.questions}
                    actionItems={ai.actionItems}
                    chapters={ai.chapters}
                    onRegenerate={() => void ai.run()}
                  />
                </div>
              </TabPanel>
            </Tabs>
          </div>

          <div className="hidden min-h-0 flex-1 lg:flex lg:flex-col">
            <TranscriptView finals={t.finals} interim={t.interim} className="flex-1" />
          </div>

          <WaveformBar level={t.level} idle={t.engineState !== "running"} />
        </div>
      </div>

      {/* Right column — desktop only */}
      <div className="hidden min-h-0 lg:block">
        <LiveAiPanel
          status={ai.status}
          tldr={ai.tldr}
          bullets={ai.bullets}
          decisions={ai.decisions}
          questions={ai.questions}
          actionItems={ai.actionItems}
          chapters={ai.chapters}
          onRegenerate={() => void ai.run()}
        />
      </div>
    </div>
  );
}

interface HeroProps {
  state: ReturnType<typeof useTranscription>["engineState"];
  modelId: WhisperModelId;
  language: string;
  deviceId?: string;
  elapsedMs: number;
  onChangeDevice: (id: string | undefined) => void;
  recordingDisabled: boolean;
  onToggleRecord: () => void;
  level: number;
  savedAt: number | null;
  fullText: string;
  onCopy: () => void;
  onClear: () => void;
  onSave: () => void;
}

/**
 * The hero card. We deliberately have a *single* primary CTA — the big
 * MicButton — and reserve the action row strictly for transcript-level
 * operations (copy / clear / save). A duplicate Start/Stop button next to
 * the mic was confusing during testing, so it's gone.
 */
function RecordingHero({
  state,
  modelId,
  language,
  deviceId,
  elapsedMs,
  onChangeDevice,
  onToggleRecord,
  level,
  savedAt,
  fullText,
  onCopy,
  onClear,
  onSave,
}: HeroProps) {
  const running = state === "running";
  const elapsedLabel = useMemo(() => formatElapsed(elapsedMs), [elapsedMs]);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-surface bg-panel-glow">
      {/*
       * Hero stays stacked until we have real horizontal room. We can't switch
       * to flex-row at `md` because the page itself uses a 2-col grid at `lg`
       * (1fr | 360px), so the left column is still narrow at md/lg. Going to
       * row earlier squeezes the middle "Ready when you are" copy down to a
       * single word per line. xl gives the title and chip row enough breathing
       * space.
       */}
      <div className="flex flex-col gap-5 p-5 md:p-6 xl:flex-row xl:items-center">
        {/* Mic — sole primary CTA in this section */}
        <div className="flex shrink-0 items-center justify-center">
          <MicButton
            state={state}
            onStart={onToggleRecord}
            onStop={onToggleRecord}
            level={level}
          />
        </div>

        {/* Status + chips */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone={running ? "danger" : "neutral"} dot>
              {running ? "Recording" : statusLabel(state)}
            </Badge>
            {running && (
              <span
                className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-text-subtle"
                aria-label={`Elapsed ${elapsedLabel}`}
              >
                <Activity className="h-3 w-3 text-rose-500" aria-hidden />
                {elapsedLabel}
              </span>
            )}
            {savedAt && !running && (
              <Badge tone="success" icon={<CircleDot className="h-2.5 w-2.5" />}>
                Saved {formatRelative(savedAt)}
              </Badge>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text">
            {running ? (
              <>
                Listening<span className="vx-gradient-text">…</span>
              </>
            ) : (
              <>
                Ready when <span className="vx-gradient-text">you are</span>
              </>
            )}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>Tap the mic, press</span>
            <Shortcut keys="mod+." variant="compact" />
            <span>or open</span>
            <Shortcut keys="mod+k" variant="compact" />
            <span>· audio never leaves your device.</span>
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="brand" icon={<Sparkles className="h-3 w-3" />}>
              {modelId}
            </Badge>
            <Badge tone="neutral">
              {language === "auto" ? "Auto-detect" : language.toUpperCase()}
            </Badge>
            <DeviceSelect
              value={deviceId}
              onChange={onChangeDevice}
              disabled={running}
              compact
              className="max-w-[220px]"
            />
          </div>
        </div>

        {/* Transcript-level actions only — recording is owned by the mic */}
        <div className="flex w-full shrink-0 flex-wrap items-center justify-start gap-2 xl:w-auto xl:justify-end">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Copy className="h-3.5 w-3.5" />}
            disabled={!fullText}
            onClick={onCopy}
          >
            Copy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Eraser className="h-3.5 w-3.5" />}
            onClick={onClear}
            disabled={!fullText}
          >
            Clear
          </Button>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Save className="h-3.5 w-3.5" />}
            onClick={onSave}
            disabled={running || !fullText}
          >
            Save session
          </Button>
        </div>
      </div>
    </section>
  );
}

function errorTitleFor(code: string): string {
  switch (code) {
    case "model-not-found":
      return "Model not found";
    case "model-load-failed":
      return "Couldn't load the model";
    case "audio-device-failed":
      return "Microphone unavailable";
    case "permission-denied":
      return "Microphone permission denied";
    case "not-supported":
      return "Not supported on this device";
    default:
      return "Engine error";
  }
}

function statusLabel(state: string): string {

  return state === "loading-model"
    ? "Loading model"
    : state === "ready"
      ? "Ready"
      : state === "error"
        ? "Error"
        : state === "paused"
          ? "Paused"
          : "Idle";
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
