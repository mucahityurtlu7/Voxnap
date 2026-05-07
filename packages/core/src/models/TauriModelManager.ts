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
 *
 * Rust event:
 *   voxnap://model-download-progress
 *     { modelId, receivedBytes, totalBytes, percent, speedBps?, state, message? }
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { WhisperModelId } from "../types.js";
import type {
  IModelManager,
  ModelDownloadProgress,
  ModelProgressHandler,
  ModelStatus,
} from "./IModelManager.js";

const TAURI_MODEL_COMMANDS = {
  list: "voxnap_list_models",
  download: "voxnap_download_model",
  cancel: "voxnap_cancel_download",
  remove: "voxnap_delete_model",
  modelsDir: "voxnap_models_dir",
} as const;

const EVT_PROGRESS = "voxnap://model-download-progress";

interface RustModelInfo {
  id: string;
  label: string;
  approxSizeMb: number;
  englishOnly: boolean;
  downloaded: boolean;
  path?: string;
  sizeBytes?: number;
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

export class TauriModelManager implements IModelManager {
  private readonly handlers = new Set<ModelProgressHandler>();
  private unlisten: UnlistenFn | null = null;
  private wired = false;

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

  onProgress(handler: ModelProgressHandler): () => void {
    this.handlers.add(handler);
    // Lazily wire — first subscriber triggers `listen()`.
    void this.wire();
    return () => {
      this.handlers.delete(handler);
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
    this.unlisten = null;
    this.wired = false;
    this.handlers.clear();
  }
}
