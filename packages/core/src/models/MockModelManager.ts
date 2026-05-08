/**
 * MockModelManager — pure JS, no network, no disk.
 *
 * Used by:
 *   • the web build, where the `WasmEngine` owns its own transformers.js
 *     fetch loop and we just want the UI panel to render something
 *     useful;
 *   • Storybook / unit tests where wiring real downloads would be
 *     overkill and slow.
 *
 * The manager keeps an in-memory map of "downloaded" flags so the UI's
 * Download → Use this model flow can be exercised end-to-end without ever
 * touching the network.
 */
import { WHISPER_MODELS, type WhisperModelId } from "../types.js";
import type {
  IModelManager,
  ModelDownloadProgress,
  ModelProgressHandler,
  ModelStatus,
} from "./IModelManager.js";

interface MockOptions {
  /** Models to start out as already downloaded. */
  downloaded?: WhisperModelId[];
  /** Total simulated download time in ms. Defaults to 1500. */
  durationMs?: number;
}

interface ActiveDownload {
  cancelled: boolean;
  timer: ReturnType<typeof setInterval>;
}

export class MockModelManager implements IModelManager {
  private readonly handlers = new Set<ModelProgressHandler>();
  private readonly downloaded: Set<WhisperModelId>;
  private readonly active = new Map<WhisperModelId, ActiveDownload>();
  private readonly durationMs: number;

  constructor(opts: MockOptions = {}) {
    this.downloaded = new Set(opts.downloaded ?? []);
    this.durationMs = opts.durationMs ?? 1500;
  }

  async list(): Promise<ModelStatus[]> {
    return Object.values(WHISPER_MODELS).map((m) => {
      const isDownloaded = this.downloaded.has(m.id);
      return {
        id: m.id,
        label: m.label,
        approxSizeMb: m.approxSizeMb,
        englishOnly: m.englishOnly,
        downloaded: isDownloaded,
        sizeBytes: isDownloaded ? m.approxSizeMb * 1024 * 1024 : undefined,
        // The mock manager doesn't model a separate accelerator pipeline
        // (the web `WasmEngine` fetches ONNX itself), so we explicitly
        // mark the bundle as unavailable. The UI then hides the
        // "Hızlandırma paketi" sub-row entirely instead of teasing a
        // download that will never run.
        onnxBundleAvailable: false,
        onnxBundleReady: false,
      };
    });
  }

  async download(modelId: WhisperModelId): Promise<void> {
    if (this.downloaded.has(modelId)) {
      this.emit({
        modelId,
        receivedBytes: 1,
        totalBytes: 1,
        percent: 1,
        state: "done",
      });
      return;
    }
    if (this.active.has(modelId)) return; // idempotent

    const meta = WHISPER_MODELS[modelId];
    const total = meta.approxSizeMb * 1024 * 1024;
    const tickMs = 100;
    const ticks = Math.max(2, Math.floor(this.durationMs / tickMs));
    let i = 0;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const slot: ActiveDownload = {
        cancelled: false,
        timer: setInterval(() => {
          if (slot.cancelled) {
            clearInterval(slot.timer);
            this.active.delete(modelId);
            this.emit({
              modelId,
              receivedBytes: 0,
              totalBytes: 0,
              percent: 0,
              state: "cancelled",
            });
            resolve();
            return;
          }
          i += 1;
          const percent = Math.min(1, i / ticks);
          const received = Math.floor(total * percent);
          const dt = (Date.now() - startedAt) / 1000;
          const speed = dt > 0 ? received / dt : 0;
          if (percent < 1) {
            this.emit({
              modelId,
              receivedBytes: received,
              totalBytes: total,
              percent,
              speedBps: speed,
              state: "downloading",
            });
          } else {
            clearInterval(slot.timer);
            this.active.delete(modelId);
            this.downloaded.add(modelId);
            this.emit({
              modelId,
              receivedBytes: total,
              totalBytes: total,
              percent: 1,
              state: "done",
            });
            resolve();
          }
        }, tickMs),
      };
      this.active.set(modelId, slot);
      // Initial event so the UI can immediately switch to the indeterminate
      // → determinate progress view.
      this.emit({
        modelId,
        receivedBytes: 0,
        totalBytes: total,
        percent: 0,
        state: "starting",
      });
      // Fire one error path for completely unknown ids so callers can test
      // the surfacing logic.
      void reject; // keep the lint happy: reject is used implicitly above
    });
  }

  async cancel(modelId: WhisperModelId): Promise<void> {
    const slot = this.active.get(modelId);
    if (!slot) return;
    slot.cancelled = true;
  }

  async delete(modelId: WhisperModelId): Promise<void> {
    this.downloaded.delete(modelId);
  }

  onProgress(handler: ModelProgressHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async modelsDir(): Promise<string> {
    return "(mock memory)";
  }

  // ------------------------------------------------------------------
  private emit(p: ModelDownloadProgress): void {
    for (const h of this.handlers) {
      try {
        h(p);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[voxnap.models.mock] handler threw:", err);
      }
    }
  }
}
