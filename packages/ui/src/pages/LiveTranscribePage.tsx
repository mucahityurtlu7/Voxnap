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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Eraser,
  Save,
  Pause,
  Play,
  Sparkles,
  CircleDot,
  Activity,
} from "lucide-react";
import {
  DEFAULT_MODEL,
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
import { Tabs, TabsList, Tab, TabPanel } from "../components/ui/Tabs.js";
import { useTranscription } from "../hooks/useTranscription.js";
import { useSummarizer } from "../engine/SummarizerProvider.js";
import { useLiveAi } from "../hooks/useLiveAi.js";
import { useSessions } from "../hooks/useSessions.js";
import { useToasts } from "../components/ui/Toast.js";

export interface LiveTranscribePageProps {
  modelId?: WhisperModelId;
  language?: string;
}

export function LiveTranscribePage({
  modelId = DEFAULT_MODEL,
  language = "auto",
}: LiveTranscribePageProps) {
  const t = useTranscription();
  const summarizer = useSummarizer();
  const { upsert } = useSessions();
  const { push: toast } = useToasts();

  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [initialised, setInitialised] = useState(false);
  const [view, setView] = useState<"transcript" | "ai">("transcript");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const startedAtRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  // Lazily initialise the engine on first mount.
  useEffect(() => {
    if (initialised) return;
    let cancelled = false;
    void t.init({ modelId, language }).then(() => {
      if (!cancelled) setInitialised(true);
    });
    return () => {
      cancelled = true;
    };
  }, [t, modelId, language, initialised]);

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

          <div className="hidden min-h-0 flex-1 lg:block">
            <TranscriptView finals={t.finals} interim={t.interim} />
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

function RecordingHero({
  state,
  modelId,
  language,
  deviceId,
  elapsedMs,
  onChangeDevice,
  recordingDisabled,
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
      <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-[auto_1fr_auto] md:items-center md:p-6">
        {/* Mic */}
        <div className="flex items-center justify-center">
          <MicButton
            state={state}
            onStart={onToggleRecord}
            onStop={onToggleRecord}
            level={level}
          />
        </div>

        {/* Status + chips */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={running ? "danger" : "neutral"} dot>
              {running ? "RECORDING" : statusLabel(state)}
            </Badge>
            {running && (
              <span className="inline-flex items-center gap-1 font-mono text-xs text-text-subtle">
                <Activity className="h-3 w-3 text-rose-500" />
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
          <p className="mt-1 text-xs text-muted">
            Press the mic, hit{" "}
            <span className="vx-kbd">⌘</span>
            <span className="vx-kbd">.</span>, or use the command palette to
            start recording. Audio never leaves your device.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="brand" icon={<Sparkles className="h-3 w-3" />}>
              {modelId}
            </Badge>
            <Badge tone="neutral">{language === "auto" ? "Auto-detect" : language.toUpperCase()}</Badge>
            <DeviceSelect
              value={deviceId}
              onChange={onChangeDevice}
              disabled={running}
              compact
              className="max-w-[220px]"
            />
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
          <Button
            variant={running ? "danger" : "primary"}
            size="md"
            leftIcon={
              running ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )
            }
            disabled={recordingDisabled}
            onClick={onToggleRecord}
            className="sm:min-w-[120px]"
          >
            {running ? "Stop" : "Start"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function statusLabel(state: string): string {
  return state === "loading-model"
    ? "LOADING MODEL"
    : state === "ready"
      ? "READY"
      : state === "error"
        ? "ERROR"
        : "IDLE";
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
