/**
 * Models store — reactive snapshot of every known whisper model + the
 * progress of any in-flight download.
 *
 * This store is **state only**: the actual download/cancel/delete actions
 * live on `IModelManager`. The `useModels` React hook in `@voxnap/ui`
 * wires the manager's events into this store and exposes a single API
 * to UI components.
 */
import { create } from "zustand";

import type { WhisperModelId } from "../types.js";
import type {
  ModelDownloadProgress,
  ModelStatus,
} from "../models/IModelManager.js";

interface ModelsState {
  /** Latest list snapshot, keyed by model id. */
  statuses: Record<string, ModelStatus>;
  /** Per-model in-flight progress (or last terminal state). */
  progress: Record<string, ModelDownloadProgress>;
  /** Tracks whether the manager has been queried at least once. */
  hydrated: boolean;
  /** When non-null, the last user-visible error message. */
  lastError: string | null;

  // Actions ----------------------------------------------------------------
  setStatuses: (list: ModelStatus[]) => void;
  applyProgress: (p: ModelDownloadProgress) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

export const useModelsStore = create<ModelsState>((set) => ({
  statuses: {},
  progress: {},
  hydrated: false,
  lastError: null,

  setStatuses: (list) =>
    set((s) => {
      const map: Record<string, ModelStatus> = {};
      for (const m of list) map[m.id] = m;
      // Drop progress entries for models that have settled (done/error/cancelled)
      // to keep the surface tidy on every refresh, but leave in-flight
      // entries alone.
      const progress = { ...s.progress };
      for (const id of Object.keys(progress)) {
        const p = progress[id]!;
        if (p.state === "done" || p.state === "cancelled") {
          delete progress[id];
        }
      }
      return { statuses: map, progress, hydrated: true };
    }),

  applyProgress: (p) =>
    set((s) => {
      const progress = { ...s.progress, [p.modelId]: p };
      let statuses = s.statuses;
      if (p.state === "done") {
        const prev = s.statuses[p.modelId];
        if (prev) {
          statuses = {
            ...s.statuses,
            [p.modelId]: {
              ...prev,
              downloaded: true,
              sizeBytes: p.totalBytes || prev.sizeBytes,
            },
          };
        }
      }
      return { progress, statuses };
    }),

  setError: (msg) => set({ lastError: msg }),

  reset: () => set({ statuses: {}, progress: {}, hydrated: false, lastError: null }),
}));

/** Convenience selector — useful in components that just need one model. */
export function selectModelStatus(
  state: ModelsState,
  id: WhisperModelId,
): ModelStatus | undefined {
  return state.statuses[id];
}

export function selectModelProgress(
  state: ModelsState,
  id: WhisperModelId,
): ModelDownloadProgress | undefined {
  return state.progress[id];
}
