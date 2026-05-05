/**
 * TauriEngine — talks to the native Rust backend over Tauri IPC.
 *
 * The Rust side owns:
 *   • microphone capture (cpal)
 *   • whisper.cpp model + inference
 *   • VAD + chunking pipeline
 *
 * This class is a thin façade. It:
 *   1. invokes commands declared in `apps/desktop/src-tauri/src/commands.rs`
 *   2. forwards Tauri events (`voxnap://*`) into our EngineEmitter
 *
 * Naming convention (KEEP IN SYNC WITH RUST):
 *   commands : voxnap_<verb>     e.g. voxnap_init, voxnap_start
 *   events   : voxnap://<topic>  e.g. voxnap://segment, voxnap://audio-level
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AudioDevice,
  AudioLevel,
  EngineConfig,
  EngineError,
  EngineState,
  TranscriptionSegment,
} from "../types.js";
import { EngineEmitter, type ITranscriptionEngine } from "./ITranscriptionEngine.js";

export const TAURI_COMMANDS = {
  init: "voxnap_init",
  listDevices: "voxnap_list_devices",
  start: "voxnap_start",
  stop: "voxnap_stop",
  dispose: "voxnap_dispose",
} as const;

export const TAURI_EVENTS = {
  segment: "voxnap://segment",
  audioLevel: "voxnap://audio-level",
  stateChange: "voxnap://state-change",
  error: "voxnap://error",
} as const;

export class TauriEngine extends EngineEmitter implements ITranscriptionEngine {
  private _state: EngineState = "idle";
  private unlisteners: UnlistenFn[] = [];
  private wired = false;

  get state(): EngineState {
    return this._state;
  }

  private setState(next: EngineState): void {
    this._state = next;
    this.emit("state-change", next);
  }

  private async wireEvents(): Promise<void> {
    if (this.wired) return;
    this.wired = true;
    this.unlisteners.push(
      await listen<TranscriptionSegment>(TAURI_EVENTS.segment, (e) => {
        this.emit("segment", e.payload);
      }),
      await listen<AudioLevel>(TAURI_EVENTS.audioLevel, (e) => {
        this.emit("audio-level", e.payload);
      }),
      await listen<EngineState>(TAURI_EVENTS.stateChange, (e) => {
        this._state = e.payload;
        this.emit("state-change", e.payload);
      }),
      await listen<EngineError>(TAURI_EVENTS.error, (e) => {
        this.emit("error", e.payload);
      }),
    );
  }

  async init(config: EngineConfig): Promise<void> {
    await this.wireEvents();
    this.setState("loading-model");
    try {
      await invoke(TAURI_COMMANDS.init, { config });
      this.setState("ready");
    } catch (err) {
      this.setState("error");
      this.emit("error", {
        code: "model-load-failed",
        message: `voxnap_init failed: ${String(err)}`,
        cause: err,
      });
      throw err;
    }
  }

  async listDevices(): Promise<AudioDevice[]> {
    return invoke<AudioDevice[]>(TAURI_COMMANDS.listDevices);
  }

  async start(deviceId?: string): Promise<void> {
    await invoke(TAURI_COMMANDS.start, { deviceId: deviceId ?? null });
    // The state change event arrives from Rust, but we set a hopeful local
    // value so UI feels snappy.
    this.setState("running");
  }

  async stop(): Promise<void> {
    await invoke(TAURI_COMMANDS.stop);
    this.setState("ready");
  }

  async dispose(): Promise<void> {
    try {
      await invoke(TAURI_COMMANDS.dispose);
    } catch {
      /* ignore — disposing should never throw upward */
    }
    for (const u of this.unlisteners) {
      try {
        u();
      } catch {
        /* noop */
      }
    }
    this.unlisteners = [];
    this.wired = false;
    this.disposeListeners();
    this.setState("disposed");
  }
}
