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
  const setLevel = useTranscriptionStore((s) => s.setLevel);
  const upsert = useTranscriptionStore((s) => s.upsertSegment);
  const clear = useTranscriptionStore((s) => s.clear);

  // Wire engine events → store, exactly once per engine instance.
  useEffect(() => {
    const offSeg = engine.on("segment", upsert);
    const offState = engine.on("state-change", setEngineState);
    const offErr = engine.on("error", setError);
    const offLvl = engine.on("audio-level", setLevel);
    return () => {
      offSeg();
      offState();
      offErr();
      offLvl();
    };
  }, [engine, upsert, setEngineState, setError, setLevel]);

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
