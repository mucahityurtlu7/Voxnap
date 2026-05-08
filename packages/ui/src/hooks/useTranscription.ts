/**
 * useTranscription — the single hook the UI actually uses.
 *
 * Responsibilities:
 *   1. Subscribe the active engine's events to the global Zustand store.
 *   2. Expose typed start/stop/clear actions.
 *   3. Memoise so React re-renders are minimal.
 *
 * Lifecycle: subscribes once per engine instance. Disposing the engine
 * (e.g. on unmount of <EngineProvider>) tears the listeners down.
 */
import { useCallback, useEffect } from "react";
import {
  selectFullTranscript,
  useTranscriptionStore,
  type EngineConfig,
  type EngineState,
  type TranscriptionSegment,
} from "@voxnap/core";

import { useEngine } from "../engine/EngineProvider.js";

export interface UseTranscriptionApi {
  engineState: EngineState;
  finals: TranscriptionSegment[];
  interim: TranscriptionSegment | null;
  fullText: string;
  level: number; // current RMS, 0..1
  start: (deviceId?: string) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
  init: (config: EngineConfig) => Promise<void>;
}

export function useTranscription(): UseTranscriptionApi {
  const engine = useEngine();
  const engineState = useTranscriptionStore((s) => s.engineState);
  const finals = useTranscriptionStore((s) => s.finals);
  const interim = useTranscriptionStore((s) => s.interim);
  const fullText = useTranscriptionStore(selectFullTranscript);
  const level = useTranscriptionStore((s) => s.level?.rms ?? 0);

  const setEngineState = useTranscriptionStore((s) => s.setEngineState);
  const setError = useTranscriptionStore((s) => s.setError);
  const setNotice = useTranscriptionStore((s) => s.setNotice);
  const setLevel = useTranscriptionStore((s) => s.setLevel);
  const upsert = useTranscriptionStore((s) => s.upsertSegment);
  const clear = useTranscriptionStore((s) => s.clear);

  // Wire engine events → store, exactly once per engine instance.
  useEffect(() => {
    const offSeg = engine.on("segment", upsert);
    const offState = engine.on("state-change", (s) => {
      // eslint-disable-next-line no-console
      console.info(`[voxnap] engine state → ${s}`);
      setEngineState(s);
    });
    const offErr = engine.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[voxnap] engine error (${err.code}): ${err.message}`,
        err.cause ?? err,
      );
      setError(err);
    });
    // Soft, informational engine notices (e.g. "running on CPU because
    // accelerator pack is still downloading"). We surface them through a
    // separate store field so the UI can render them as info toasts
    // instead of the scary red error surface.
    const offNotice = engine.on("notice", (n) => {
      // eslint-disable-next-line no-console
      console.info(`[voxnap] engine notice (${n.code}): ${n.message}`);
      setNotice(n);
    });
    const offLvl = engine.on("audio-level", setLevel);
    return () => {
      offSeg();
      offState();
      offErr();
      offNotice();
      offLvl();
    };
  }, [engine, upsert, setEngineState, setError, setNotice, setLevel]);


  const init = useCallback(
    (config: EngineConfig) => engine.init(config),
    [engine],
  );
  const start = useCallback(
    (deviceId?: string) => engine.start(deviceId),
    [engine],
  );
  const stop = useCallback(() => engine.stop(), [engine]);

  return { engineState, finals, interim, fullText, level, start, stop, clear, init };
}
