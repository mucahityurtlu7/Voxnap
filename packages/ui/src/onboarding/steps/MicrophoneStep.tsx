/**
 * MicrophoneStep — request mic permission, list devices, run a level test.
 *
 * Uses the platform-specific engine via `useEngine()` so the same code
 * works for the desktop (Tauri/cpal) and web (AudioWorklet) builds. The
 * mock engine always succeeds, which keeps tests + Storybook trivial.
 *
 * The level test starts only when the user clicks "Test microphone" so we
 * don't grab the device the moment the wizard mounts.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Square,
} from "lucide-react";
import type { AudioDevice } from "@voxnap/core";

import { useEngine } from "../../engine/EngineProvider.js";
import { Badge } from "../../components/ui/Badge.js";
import { Button } from "../../components/ui/Button.js";
import { WaveformBar } from "../../components/WaveformBar.js";

export interface MicrophoneStepProps {
  deviceId: string;
  onDeviceChange: (id: string) => void;
  verified: boolean;
  onVerifiedChange: (v: boolean) => void;
}

type TestState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export function MicrophoneStep({
  deviceId,
  onDeviceChange,
  verified,
  onVerifiedChange,
}: MicrophoneStepProps) {
  const engine = useEngine();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [level, setLevel] = useState(0);
  const peakRef = useRef(0);

  // Initial device listing.
  useEffect(() => {
    let cancelled = false;
    engine
      .listDevices()
      .then((list) => {
        if (cancelled) return;
        setDevices(list);
        if (!deviceId) {
          const def = list.find((d) => d.isDefault) ?? list[0];
          if (def) onDeviceChange(def.id);
        }
      })
      .catch((e) => {
        if (!cancelled) setListError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // Subscribe to live audio levels while a test is running.
  useEffect(() => {
    if (test.kind !== "running") return;
    const off = engine.on("audio-level", (lvl) => {
      setLevel(lvl.rms);
      if (lvl.rms > peakRef.current) peakRef.current = lvl.rms;
      // 0.05 RMS is the lowest we'll trust as "actual speech-ish energy".
      if (lvl.rms > 0.05 && !verified) onVerifiedChange(true);
    });
    return () => off();
  }, [engine, test.kind, verified, onVerifiedChange]);

  // Stop the engine if the user clicks Back / closes the page mid-test.
  useEffect(() => {
    return () => {
      void engine.stop();
    };
  }, [engine]);

  const startTest = async () => {
    setTest({ kind: "starting" });
    peakRef.current = 0;
    try {
      await engine.start(deviceId || undefined);
      setTest({ kind: "running" });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not access the microphone.";
      setTest({ kind: "error", message });
    }
  };

  const stopTest = async () => {
    try {
      await engine.stop();
    } finally {
      setTest({ kind: "idle" });
      setLevel(0);
    }
  };

  const isRunning = test.kind === "running";
  const isStarting = test.kind === "starting";

  return (
    <div className="flex flex-col gap-3">
      {/* Device picker ------------------------------------------------- */}
      <div>
        <label
          htmlFor="vx-onboarding-mic-device"
          className="text-sm font-medium text-text"
        >
          Input device
        </label>
        <p className="mt-0.5 text-xs text-muted">
          Pick the microphone you'll record with most often. You can change
          it later from Settings.
        </p>
        <div className="relative mt-2">
          <Mic className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <select
            id="vx-onboarding-mic-device"
            value={deviceId}
            disabled={isRunning || isStarting}
            onChange={(e) => onDeviceChange(e.target.value)}
            className={clsx(
              "h-10 w-full appearance-none rounded-lg border border-border bg-surface-2 pl-9 pr-3 text-sm text-text outline-none",
              "focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {devices.length === 0 && <option value="">Default device</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
                {d.isDefault ? " · default" : ""}
              </option>
            ))}
          </select>
        </div>
        {listError && (
          <p className="mt-2 text-xs text-rose-500">
            Couldn't list devices: {listError}
          </p>
        )}
      </div>

      {/* Live waveform ------------------------------------------------- */}
      <div className="rounded-xl border border-border bg-surface-2 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text">Live preview</div>
            <p className="mt-0.5 text-xs text-muted">
              Speak normally — you should see the bars dance.
            </p>
          </div>
          <StatusBadge
            verified={verified}
            running={isRunning}
            error={test.kind === "error"}
          />
        </div>

        <WaveformBar level={level} idle={!isRunning} />

        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="text-[11px] font-mono text-muted">
            level {(level * 100).toFixed(0).padStart(2, "0")}% · peak{" "}
            {(peakRef.current * 100).toFixed(0).padStart(2, "0")}%
          </div>
          {isRunning ? (
            <Button
              variant="danger"
              size="sm"
              leftIcon={<Square className="h-3.5 w-3.5" />}
              onClick={() => void stopTest()}
            >
              Stop test
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={isStarting}
              leftIcon={!isStarting ? <Mic className="h-3.5 w-3.5" /> : null}
              onClick={() => void startTest()}
            >
              {verified ? "Re-test" : "Test microphone"}
            </Button>
          )}
        </div>

        {test.kind === "error" && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-500">
            <MicOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div className="font-medium">Microphone unavailable</div>
              <div className="mt-0.5 opacity-90">{test.message}</div>
              <div className="mt-1 opacity-80">
                You can skip this step and configure the mic later.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({
  verified,
  running,
  error,
}: {
  verified: boolean;
  running: boolean;
  error: boolean;
}) {
  if (error) {
    return (
      <Badge tone="danger" icon={<AlertTriangle className="h-3 w-3" />}>
        Failed
      </Badge>
    );
  }
  if (verified) {
    return (
      <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>
        Working
      </Badge>
    );
  }
  if (running) {
    return (
      <Badge tone="brand" icon={<Loader2 className="h-3 w-3 animate-spin" />}>
        Listening…
      </Badge>
    );
  }
  return <Badge tone="neutral">Not tested</Badge>;
}
