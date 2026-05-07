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
}

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
}
