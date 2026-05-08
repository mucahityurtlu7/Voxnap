/**
 * useModels — bridges `IModelManager` events into `useModelsStore` and
 * exposes a single, ergonomic API for UI components.
 *
 * The hook auto-hydrates on mount (`manager.list()`), subscribes to
 * progress events, and re-fetches the list whenever a download finishes
 * or a model is deleted so `downloaded` flags stay accurate.
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  useModelsStore,
  type ModelDownloadProgress,
  type ModelStatus,
  type OnnxBundleProgress,
  type WhisperModelId,
} from "@voxnap/core";

import { useModelManager } from "../engine/ModelManagerProvider.js";

export interface UseModelsApi {
  /** Sorted by approximate size (asc) so the list reads small → large. */
  statuses: ModelStatus[];
  progress: Record<string, ModelDownloadProgress>;
  /** Per-model ONNX accelerator-bundle progress map (may be empty). */
  onnxProgress: Record<string, OnnxBundleProgress>;
  hydrated: boolean;
  lastError: string | null;
  /**
   * `true` if the active manager exposes the ONNX bundle commands.
   * The `ModelManagerPanel` hides the accelerator-pack affordances when
   * this is `false` (e.g. on the web build, which doesn't have a
   * separate accelerator pipeline).
   */
  supportsOnnxBundle: boolean;

  refresh: () => Promise<void>;
  download: (id: WhisperModelId) => Promise<void>;
  cancel: (id: WhisperModelId) => Promise<void>;
  remove: (id: WhisperModelId) => Promise<void>;
  /** Manually start (or re-try) the ONNX accelerator-bundle download. */
  downloadOnnxBundle: (id: WhisperModelId) => Promise<void>;
  /** Delete the ONNX accelerator bundle. */
  deleteOnnxBundle: (id: WhisperModelId) => Promise<void>;

  /** Convenience: get one model's status quickly. */
  getStatus: (id: WhisperModelId) => ModelStatus | undefined;
  getProgress: (id: WhisperModelId) => ModelDownloadProgress | undefined;
  getOnnxProgress: (id: WhisperModelId) => OnnxBundleProgress | undefined;
}

export function useModels(): UseModelsApi {
  const manager = useModelManager();

  const statusesMap = useModelsStore((s) => s.statuses);
  const progress = useModelsStore((s) => s.progress);
  const onnxProgress = useModelsStore((s) => s.onnxProgress);
  const hydrated = useModelsStore((s) => s.hydrated);
  const lastError = useModelsStore((s) => s.lastError);
  const setStatuses = useModelsStore((s) => s.setStatuses);
  const applyProgress = useModelsStore((s) => s.applyProgress);
  const applyOnnxProgress = useModelsStore((s) => s.applyOnnxProgress);
  const setError = useModelsStore((s) => s.setError);

  const supportsOnnxBundle = Boolean(
    manager.downloadOnnxBundle && manager.onOnnxBundleProgress,
  );

  const refresh = useCallback(async () => {
    try {
      const list = await manager.list();
      setStatuses(list);
      setError(null);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      // eslint-disable-next-line no-console
      console.error("[voxnap.models] list failed:", err);
      setError(message);
    }
  }, [manager, setStatuses, setError]);

  // Hydrate + subscribe to progress events for the lifetime of the
  // mounting component tree (typically the entire app).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled) return;
    })();
    const off = manager.onProgress((p) => {
      applyProgress(p);
      // Refresh on terminal transitions so `downloaded` is always honest.
      if (p.state === "done" || p.state === "cancelled" || p.state === "error") {
        void refresh();
      }
    });
    const offOnnx = manager.onOnnxBundleProgress?.((p) => {
      applyOnnxProgress(p);
      if (
        p.state === "done" ||
        p.state === "error" ||
        p.state === "deleted" ||
        p.state === "skipped"
      ) {
        void refresh();
      }
    });
    return () => {
      cancelled = true;
      off();
      offOnnx?.();
    };
  }, [manager, applyProgress, applyOnnxProgress, refresh]);

  const download = useCallback(
    async (id: WhisperModelId) => {
      try {
        setError(null);
        await manager.download(id);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        // eslint-disable-next-line no-console
        console.error(`[voxnap.models] download(${id}) failed:`, err);
        setError(message);
        throw err;
      }
    },
    [manager, setError],
  );

  const cancel = useCallback(
    async (id: WhisperModelId) => {
      try {
        await manager.cancel(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[voxnap.models] cancel(${id}) failed:`, err);
      }
    },
    [manager],
  );

  const remove = useCallback(
    async (id: WhisperModelId) => {
      try {
        await manager.delete(id);
        await refresh();
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        // eslint-disable-next-line no-console
        console.error(`[voxnap.models] delete(${id}) failed:`, err);
        setError(message);
      }
    },
    [manager, refresh, setError],
  );

  const downloadOnnxBundle = useCallback(
    async (id: WhisperModelId) => {
      if (!manager.downloadOnnxBundle) return;
      try {
        setError(null);
        await manager.downloadOnnxBundle(id);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        // eslint-disable-next-line no-console
        console.error(`[voxnap.models] downloadOnnxBundle(${id}) failed:`, err);
        setError(message);
        throw err;
      }
    },
    [manager, setError],
  );

  const deleteOnnxBundle = useCallback(
    async (id: WhisperModelId) => {
      if (!manager.deleteOnnxBundle) return;
      try {
        await manager.deleteOnnxBundle(id);
        await refresh();
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        // eslint-disable-next-line no-console
        console.error(`[voxnap.models] deleteOnnxBundle(${id}) failed:`, err);
        setError(message);
      }
    },
    [manager, refresh, setError],
  );

  // Stable, sorted list. Sort by size so the cheapest model shows first.
  const statuses = useMemo(() => {
    return Object.values(statusesMap).sort(
      (a, b) => a.approxSizeMb - b.approxSizeMb,
    );
  }, [statusesMap]);

  const getStatus = useCallback(
    (id: WhisperModelId) => statusesMap[id],
    [statusesMap],
  );
  const getProgress = useCallback(
    (id: WhisperModelId) => progress[id],
    [progress],
  );
  const getOnnxProgress = useCallback(
    (id: WhisperModelId) => onnxProgress[id],
    [onnxProgress],
  );

  return {
    statuses,
    progress,
    onnxProgress,
    hydrated,
    lastError,
    supportsOnnxBundle,
    refresh,
    download,
    cancel,
    remove,
    downloadOnnxBundle,
    deleteOnnxBundle,
    getStatus,
    getProgress,
    getOnnxProgress,
  };
}
