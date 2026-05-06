/**
 * Global transcription state — a single source of truth that any UI
 * component can subscribe to. Built on Zustand for minimal boilerplate.
 *
 * The store knows nothing about the engine. The wiring (engine → store)
 * happens inside the `useTranscription` hook in `@voxnap/ui` so that
 * `@voxnap/core` stays React-free.
 */
import { create } from "zustand";

import type {
  AudioLevel,
  EngineError,
  EngineState,
  TranscriptionSegment,
} from "../types.js";

export interface TranscriptionState {
  // -- engine status -----------------------------------------------------
  engineState: EngineState;
  lastError: EngineError | null;

  // -- session content ---------------------------------------------------
  /** Already-finalised segments, in chronological order. */
  finals: TranscriptionSegment[];
  /** The latest interim segment (may be null when nothing is in progress). */
  interim: TranscriptionSegment | null;

  // -- realtime audio meter ---------------------------------------------
  level: AudioLevel | null;

  // -- mutators ----------------------------------------------------------
  setEngineState: (s: EngineState) => void;
  setError: (e: EngineError | null) => void;
  upsertSegment: (segment: TranscriptionSegment) => void;
  setLevel: (l: AudioLevel) => void;
  clear: () => void;
}

export const useTranscriptionStore = create<TranscriptionState>((set) => ({
  engineState: "idle",
  lastError: null,
  finals: [],
  interim: null,
  level: null,

  setEngineState: (engineState) => set({ engineState }),
  setError: (lastError) => set({ lastError }),
  setLevel: (level) => set({ level }),

  upsertSegment: (segment) =>
    set((state) => {
      // Interim update: just replace whatever is in the interim slot.
      // We deliberately don't key partials by id — the engine sends a
      // single `seg-live` interim and a separate `seg-<startMs>` final
      // for each utterance, and trying to track them by id leaves the
      // old partial stuck on screen after its final has already arrived.
      if (!segment.isFinal) {
        return { interim: segment };
      }

      // Final segment: it implicitly supersedes the live partial, so
      // always clear the interim. (Without this, the previous partial
      // text lingers under the new final until the next partial arrives,
      // which causes the "duplicate trailing words" effect users see.)
      const idx = state.finals.findIndex((s) => s.id === segment.id);
      const finals =
        idx >= 0
          ? state.finals.map((s, i) => (i === idx ? segment : s))
          : [...state.finals, segment];
      return { finals, interim: null };
    }),

  clear: () => set({ finals: [], interim: null, lastError: null }),
}));

/** Concatenate all finalised segments into a single transcript string. */
export function selectFullTranscript(state: TranscriptionState): string {
  return state.finals.map((s) => s.text).join(" ").trim();
}
