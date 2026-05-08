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
  OnnxBundleProgress,
} from "../models/IModelManager.js";

interface ModelsState {
  /** Latest list snapshot, keyed by model id. */
  statuses: Record<string, ModelStatus>;
  /** Per-model in-flight progress (or last terminal state). */
  progress: Record<string, ModelDownloadProgress>;
  /**
   * Per-model ONNX accelerator-bundle progress. Driven by the optional
   * `onOnnxBundleProgress` event stream on `IModelManager`. Tracked as a
   * separate map so the UI can render the ggml + onnx download chips
   * independently inside the same row.
   */
  onnxProgress: Record<string, OnnxBundleProgress>;
  /** Tracks whether the manager has been queried at least once. */
  hydrated: boolean;
  /** When non-null, the last user-visible error message. */
  lastError: string | null;

  // Actions ----------------------------------------------------------------
  setStatuses: (list: ModelStatus[]) => void;
  applyProgress: (p: ModelDownloadProgress) => void;
  applyOnnxProgress: (p: OnnxBundleProgress) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

export const useModelsStore = create<ModelsState>((set) => ({
  statuses: {},
  progress: {},
  onnxProgress: {},
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
      // Same for ONNX bundle progress: drop terminal entries when the
      // refreshed status reflects the final state, but leave the
      // bundle-level `done` row in place if the on-disk probe still
      // disagrees (fixes a UI flicker we saw after the rename rename).
      const onnxProgress = { ...s.onnxProgress };
      for (const id of Object.keys(onnxProgress)) {
        const p = onnxProgress[id]!;
        const refreshed = map[id];
        if (
          (p.state === "done" || p.state === "deleted" || p.state === "skipped") &&
          refreshed?.onnxBundleReady === (p.state === "done")
        ) {
          delete onnxProgress[id];
        }
      }
      return { statuses: map, progress, onnxProgress, hydrated: true };
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

  applyOnnxProgress: (p) =>
    set((s) => {
      const onnxProgress = { ...s.onnxProgress, [p.modelId]: p };
      let statuses = s.statuses;
      // Optimistically flip the per-model `onnxBundleReady` flag on
      // terminal events so the UI rosette updates without waiting for
      // the next `list()` refresh.
      const prev = s.statuses[p.modelId];
      if (prev) {
        if (p.state === "done") {
          statuses = {
            ...s.statuses,
            [p.modelId]: {
              ...prev,
              onnxBundleReady: true,
              onnxBundleSizeBytes: p.totalBytes || prev.onnxBundleSizeBytes,
            },
          };
        } else if (p.state === "deleted") {
          statuses = {
            ...s.statuses,
            [p.modelId]: {
              ...prev,
              onnxBundleReady: false,
              onnxBundleSizeBytes: undefined,
            },
          };
        }
      }
      return { onnxProgress, statuses };
    }),

  setError: (msg) => set({ lastError: msg }),

  reset: () =>
    set({ statuses: {}, progress: {}, onnxProgress: {}, hydrated: false, lastError: null }),
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

export function selectOnnxBundleProgress(
  state: ModelsState,
  id: WhisperModelId,
): OnnxBundleProgress | undefined {
  return state.onnxProgress[id];
}
