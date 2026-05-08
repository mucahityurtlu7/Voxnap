/**
 * TauriModelManager — talks to the native Rust backend over Tauri IPC.
 *
 * Rust commands (declared in `apps/desktop/src-tauri/src/commands.rs`):
 *
 *   voxnap_list_models                            → ModelInfo[]
 *   voxnap_download_model { modelId }             → ()
 *   voxnap_cancel_download { modelId }            → boolean
 *   voxnap_delete_model   { modelId }             → ()
 *   voxnap_models_dir                             → string
 *   voxnap_download_onnx_bundle { modelId }       → ()
 *   voxnap_delete_onnx_bundle   { modelId }       → ()
 *
 * Rust events:
 *   voxnap://model-download-progress
 *     { modelId, receivedBytes, totalBytes, percent, speedBps?, state, message? }
 *   voxnap://onnx-bundle-progress
 *     { modelId, onnxId, file?, fileIndex, fileCount,
 *       receivedBytes, totalBytes, percent, state, message? }
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { WhisperModelId } from "../types.js";
import type {
  IModelManager,
  ModelDownloadProgress,
  ModelProgressHandler,
  ModelStatus,
  OnnxBundleProgress,
  OnnxBundleProgressHandler,
} from "./IModelManager.js";

const TAURI_MODEL_COMMANDS = {
  list: "voxnap_list_models",
  download: "voxnap_download_model",
  cancel: "voxnap_cancel_download",
  remove: "voxnap_delete_model",
  modelsDir: "voxnap_models_dir",
  downloadOnnx: "voxnap_download_onnx_bundle",
  deleteOnnx: "voxnap_delete_onnx_bundle",
} as const;

const EVT_PROGRESS = "voxnap://model-download-progress";
const EVT_ONNX_PROGRESS = "voxnap://onnx-bundle-progress";

interface RustModelInfo {
  id: string;
  label: string;
  approxSizeMb: number;
  englishOnly: boolean;
  downloaded: boolean;
  path?: string;
  sizeBytes?: number;
  onnxBundleReady: boolean;
  onnxBundleSizeBytes?: number;
  onnxBundleAvailable: boolean;
}

interface RustProgressPayload {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  speedBps?: number;
  state: ModelDownloadProgress["state"];
  message?: string;
}

interface RustOnnxProgressPayload {
  modelId: string;
  onnxId: string;
  file?: string;
  fileIndex: number;
  fileCount: number;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  state: OnnxBundleProgress["state"];
  message?: string;
}

export class TauriModelManager implements IModelManager {
  private readonly handlers = new Set<ModelProgressHandler>();
  private readonly onnxHandlers = new Set<OnnxBundleProgressHandler>();
  private unlisten: UnlistenFn | null = null;
  private unlistenOnnx: UnlistenFn | null = null;
  private wired = false;
  private wiredOnnx = false;

  private async wire(): Promise<void> {
    if (this.wired) return;
    this.wired = true;
    try {
      this.unlisten = await listen<RustProgressPayload>(EVT_PROGRESS, (e) => {
        const p: ModelDownloadProgress = {
          modelId: e.payload.modelId as WhisperModelId,
          receivedBytes: e.payload.receivedBytes,
          totalBytes: e.payload.totalBytes,
          percent: e.payload.percent,
          speedBps: e.payload.speedBps,
          state: e.payload.state,
          message: e.payload.message,
        };
        for (const h of this.handlers) {
          try {
            h(p);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[voxnap.models] progress handler threw:", err);
          }
        }
      });
    } catch (err) {
      this.wired = false;
      // eslint-disable-next-line no-console
      console.error("[voxnap.models] failed to wire progress events:", err);
      throw err;
    }
  }

  private async wireOnnx(): Promise<void> {
    if (this.wiredOnnx) return;
    this.wiredOnnx = true;
    try {
      this.unlistenOnnx = await listen<RustOnnxProgressPayload>(
        EVT_ONNX_PROGRESS,
        (e) => {
          const p: OnnxBundleProgress = {
            modelId: e.payload.modelId as WhisperModelId,
            onnxId: e.payload.onnxId,
            file: e.payload.file ?? null,
            fileIndex: e.payload.fileIndex,
            fileCount: e.payload.fileCount,
            receivedBytes: e.payload.receivedBytes,
            totalBytes: e.payload.totalBytes,
            percent: e.payload.percent,
            state: e.payload.state,
            message: e.payload.message,
          };
          for (const h of this.onnxHandlers) {
            try {
              h(p);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error("[voxnap.models] onnx handler threw:", err);
            }
          }
        },
      );
    } catch (err) {
      this.wiredOnnx = false;
      // eslint-disable-next-line no-console
      console.error("[voxnap.models] failed to wire onnx events:", err);
      throw err;
    }
  }

  async list(): Promise<ModelStatus[]> {
    await this.wire();
    const raw = await invoke<RustModelInfo[]>(TAURI_MODEL_COMMANDS.list);
    return raw.map((m) => ({
      id: m.id as WhisperModelId,
      label: m.label,
      approxSizeMb: m.approxSizeMb,
      englishOnly: m.englishOnly,
      downloaded: m.downloaded,
      path: m.path,
      sizeBytes: m.sizeBytes,
      onnxBundleReady: m.onnxBundleReady,
      onnxBundleSizeBytes: m.onnxBundleSizeBytes,
      onnxBundleAvailable: m.onnxBundleAvailable,
    }));
  }

  async download(modelId: WhisperModelId): Promise<void> {
    await this.wire();
    await invoke(TAURI_MODEL_COMMANDS.download, { modelId });
  }

  async cancel(modelId: WhisperModelId): Promise<void> {
    await invoke(TAURI_MODEL_COMMANDS.cancel, { modelId });
  }

  async delete(modelId: WhisperModelId): Promise<void> {
    await invoke(TAURI_MODEL_COMMANDS.remove, { modelId });
  }

  async modelsDir(): Promise<string> {
    return await invoke<string>(TAURI_MODEL_COMMANDS.modelsDir);
  }

  async downloadOnnxBundle(modelId: WhisperModelId): Promise<void> {
    await this.wireOnnx();
    await invoke(TAURI_MODEL_COMMANDS.downloadOnnx, { modelId });
  }

  async deleteOnnxBundle(modelId: WhisperModelId): Promise<void> {
    await invoke(TAURI_MODEL_COMMANDS.deleteOnnx, { modelId });
  }

  onProgress(handler: ModelProgressHandler): () => void {
    this.handlers.add(handler);
    // Lazily wire — first subscriber triggers `listen()`.
    void this.wire();
    return () => {
      this.handlers.delete(handler);
    };
  }

  onOnnxBundleProgress(handler: OnnxBundleProgressHandler): () => void {
    this.onnxHandlers.add(handler);
    void this.wireOnnx();
    return () => {
      this.onnxHandlers.delete(handler);
    };
  }

  async dispose(): Promise<void> {
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch {
        /* noop */
      }
    }
    if (this.unlistenOnnx) {
      try {
        this.unlistenOnnx();
      } catch {
        /* noop */
      }
    }
    this.unlisten = null;
    this.unlistenOnnx = null;
    this.wired = false;
    this.wiredOnnx = false;
    this.handlers.clear();
    this.onnxHandlers.clear();
  }
}
