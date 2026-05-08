/**
 * Model management abstraction.
 *
 * Voxnap can run on three platforms (Tauri desktop, Tauri mobile, web). Each
 * has a different way of fetching and storing whisper.cpp model files:
 *
 *   • Tauri (desktop / mobile): the Rust backend streams the file from
 *     huggingface.co into `<app-data>/models` and emits IPC progress events.
 *   • Web: the browser cannot persist multi-hundred-MB blobs reliably; the
 *     `WasmEngine` itself handles model fetching via transformers.js, so the
 *     web `IModelManager` is mostly a stub that reports availability.
 *   • Mock (used in CI / Storybook): a fake downloader that just `setInterval`s
 *     its way from 0% → 100%.
 *
 * The UI layer never branches on the platform — it just calls
 * `useModelManager()` and renders whatever statuses the manager reports.
 */
import type { WhisperModelId } from "../types.js";

/** Lifecycle stages that a download can be in. */
export type ModelDownloadState =
  | "idle"
  | "starting"
  | "downloading"
  | "done"
  | "error"
  | "cancelled";

/** Static + dynamic info for a single ggml model. */
export interface ModelStatus {
  id: WhisperModelId;
  label: string;
  approxSizeMb: number;
  englishOnly: boolean;
  /** True if the file already exists on disk (or in the wasm cache). */
  downloaded: boolean;
  /** Absolute path to the on-disk file, when known. */
  path?: string;
  /** Actual file size in bytes, when known. */
  sizeBytes?: number;
  /**
   * `true` when the ONNX accelerator bundle for this model is fully
   * resident on disk. The UI uses this to render the "Hızlandırma
   * paketi hazır" rosette next to a model row.
   */
  onnxBundleReady?: boolean;
  /** Total on-disk size of the ONNX bundle in bytes, when present. */
  onnxBundleSizeBytes?: number;
  /**
   * `true` if a Xenova ONNX mirror exists for this model id at all.
   * `false` means we never publish ONNX for this model — the UI grays
   * out the accelerator chip instead of advertising a missing pack.
   */
  onnxBundleAvailable?: boolean;
}

/**
 * Streaming progress for an ONNX accelerator-bundle download (a
 * separate, per-file pipeline that runs in parallel to the ggml
 * download). Mirrors the Rust-side `OnnxProgressEvent`.
 */
export interface OnnxBundleProgress {
  /** Same id the parent `ModelStatus` carries — `base.q5_1`, etc. */
  modelId: WhisperModelId;
  /** Bare ONNX id (`base`, `tiny.en`, …) — useful for diagnostics. */
  onnxId: string;
  /** Currently downloading file; `null` for bundle-level events. */
  file: string | null;
  fileIndex: number;
  fileCount: number;
  receivedBytes: number;
  totalBytes: number;
  /** 0..1, clamped on the producing side. */
  percent: number;
  /**
   * Lifecycle state. `"skipped"` is emitted when the requested model
   * has no Xenova ONNX mirror; the UI should show "no accelerator
   * pack available for this model" rather than a stuck spinner.
   * `"deleted"` is emitted by `voxnap_delete_onnx_bundle` so the UI
   * flips its rosette back to the "not installed" state.
   */
  state:
    | "starting"
    | "downloading"
    | "done"
    | "error"
    | "skipped"
    | "deleted";
  /** Free-form detail; populated on `error` and `skipped`. */
  message?: string;
}

export type OnnxBundleProgressHandler = (p: OnnxBundleProgress) => void;


/**
 * Streaming progress for a single in-flight download. Emitted by every
 * implementation to let the UI render a determinate progress bar without
 * caring about the underlying transport.
 */
export interface ModelDownloadProgress {
  modelId: WhisperModelId;
  receivedBytes: number;
  totalBytes: number;
  /** 0..1 — clamped on the producing side. */
  percent: number;
  /** Bytes per second, when computable. */
  speedBps?: number;
  state: ModelDownloadState;
  /** Set on `error` (and sometimes on `cancelled` for context). */
  message?: string;
}

export type ModelProgressHandler = (p: ModelDownloadProgress) => void;

/**
 * Cross-platform contract for managing whisper model files.
 *
 * Implementations:
 *   • `TauriModelManager` — talks to Rust via IPC.
 *   • `MockModelManager`  — fake progress, no network. Useful for the web
 *     build (where the `WasmEngine` owns its own fetch loop) and for tests.
 */
export interface IModelManager {
  /** Snapshot of every known model + whether it's already on disk. */
  list(): Promise<ModelStatus[]>;

  /**
   * Begin (or resume) a download. Resolves once the file is on disk and a
   * `done` progress event has been emitted; rejects on hard errors.
   */
  download(modelId: WhisperModelId): Promise<void>;

  /** Ask any in-flight download for `modelId` to abort cleanly. */
  cancel(modelId: WhisperModelId): Promise<void>;

  /** Delete a downloaded model file. No-op if it isn't on disk. */
  delete(modelId: WhisperModelId): Promise<void>;

  /** Subscribe to progress events. Returns an unsubscribe fn. */
  onProgress(handler: ModelProgressHandler): () => void;

  /**
   * Path to the writable models directory, when meaningful. Returned for
   * display purposes only — never use it as an addressable identifier.
   */
  modelsDir?(): Promise<string>;

  /**
   * Manually trigger an ONNX accelerator-bundle download for `modelId`.
   * Optional — implementations that don't have a separate accelerator
   * pipeline (e.g. the web `WasmEngine` which fetches its own model)
   * may omit this. The UI hides the related controls when it isn't
   * available on the current manager.
   */
  downloadOnnxBundle?(modelId: WhisperModelId): Promise<void>;

  /**
   * Delete the ONNX accelerator bundle for `modelId`. No-op when the
   * bundle isn't on disk.
   */
  deleteOnnxBundle?(modelId: WhisperModelId): Promise<void>;

  /**
   * Subscribe to ONNX bundle progress events. Optional, see
   * `downloadOnnxBundle`. The returned function unsubscribes the
   * handler — it does *not* cancel any in-flight download.
   */
  onOnnxBundleProgress?(handler: OnnxBundleProgressHandler): () => void;
}
