/**
 * TauriEngine — talks to the native Rust backend over Tauri IPC.
 *
 * The Rust side owns:
 *   • microphone capture (cpal)
 *   • whisper.cpp model + inference
 *   • VAD + chunking pipeline
 *   • lifecycle / state transitions (single source of truth)
 *
 * This class is a thin façade. It:
 *   1. invokes commands declared in `apps/desktop/src-tauri/src/commands.rs`
 *   2. forwards Tauri events (`voxnap://*`) into our EngineEmitter
 *
 * Naming convention (KEEP IN SYNC WITH RUST):
 *   commands : voxnap_<verb>      e.g. voxnap_init, voxnap_start
 *   events   : voxnap://<topic>   e.g. voxnap://segment, voxnap://audio-level
 *
 * State authority:
 *   The engine state on this side is *driven by Rust*. We never set it
 *   optimistically; that would race with the real lifecycle event and
 *   cause flicker (e.g. "running" → "ready" → "running"). The Rust
 *   commands are responsible for emitting the correct `state-change`
 *   payloads.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AcceleratorInfo,
  AudioDevice,
  AudioLevel,
  DiagnosticReport,
  EngineConfig,
  EngineError,
  EngineState,
  TranscriptionSegment,
} from "../types.js";
import { EngineEmitter, type ITranscriptionEngine } from "./ITranscriptionEngine.js";

export const TAURI_COMMANDS = {
  init: "voxnap_init",
  listDevices: "voxnap_list_devices",
  listAccelerators: "voxnap_list_accelerators",
  diagnoseAccelerators: "voxnap_diagnose_accelerators",
  start: "voxnap_start",
  stop: "voxnap_stop",
  dispose: "voxnap_dispose",
} as const;

export const TAURI_EVENTS = {
  segment: "voxnap://segment",
  audioLevel: "voxnap://audio-level",
  stateChange: "voxnap://state-change",
  error: "voxnap://error",
  /**
   * Soft, informational notices the Rust side emits for non-error
   * fallbacks (e.g. "ONNX bundle missing — running on CPU until the
   * accelerator pack finishes downloading"). The UI surfaces these as
   * a quiet info chip rather than a red error toast.
   */
  notice: "voxnap://notice",
} as const;

/** Shape Rust emits for `voxnap://segment` (camelCase via serde rename_all). */
interface RustSegmentPayload {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

/** Shape Rust emits for `voxnap://error`. */
interface RustErrorPayload {
  code: EngineError["code"];
  message: string;
}

/** Shape Rust emits for `voxnap://notice`. */
interface RustNoticePayload {
  code: string;
  message: string;
  severity?: "info" | "warning";
}

export class TauriEngine extends EngineEmitter implements ITranscriptionEngine {
  private _state: EngineState = "idle";
  private unlisteners: UnlistenFn[] = [];
  private wired = false;

  get state(): EngineState {
    return this._state;
  }

  private async wireEvents(): Promise<void> {
    if (this.wired) return;
    this.wired = true;
    this.unlisteners.push(
      await listen<RustSegmentPayload>(TAURI_EVENTS.segment, (e) => {
        // Rust payload is already in our TranscriptionSegment shape.
        const seg: TranscriptionSegment = {
          id: e.payload.id,
          text: e.payload.text,
          startMs: e.payload.startMs,
          endMs: e.payload.endMs,
          isFinal: e.payload.isFinal,
          confidence: e.payload.confidence,
          language: e.payload.language,
        };
        this.emit("segment", seg);
      }),
      await listen<AudioLevel>(TAURI_EVENTS.audioLevel, (e) => {
        this.emit("audio-level", e.payload);
      }),
      await listen<EngineState>(TAURI_EVENTS.stateChange, (e) => {
        // eslint-disable-next-line no-console
        console.info(`[voxnap.tauri] state-change → ${e.payload}`);
        this._state = e.payload;
        this.emit("state-change", e.payload);
      }),
      await listen<RustErrorPayload | string>(TAURI_EVENTS.error, (e) => {
        const payload = e.payload;
        // Rust may send a string (older builds) or a structured payload.
        const err =
          typeof payload === "string"
            ? { code: "engine-internal" as const, message: payload }
            : {
                code: payload.code ?? "engine-internal",
                message: payload.message ?? JSON.stringify(payload),
              };
        // eslint-disable-next-line no-console
        console.error(
          `[voxnap.tauri] engine error (${err.code}): ${err.message}`,
          payload,
        );
        this.emit("error", err);
      }),
      await listen<RustNoticePayload>(TAURI_EVENTS.notice, (e) => {
        const p = e.payload;
        // eslint-disable-next-line no-console
        console.info(`[voxnap.tauri] notice (${p.code}): ${p.message}`);
        this.emit("notice", {
          code: p.code,
          message: p.message,
          severity: p.severity,
        });
      }),
    );
  }

  async init(config: EngineConfig): Promise<void> {
    await this.wireEvents();
    // eslint-disable-next-line no-console
    console.info("[voxnap.tauri] init", config);
    try {
      // Rust emits state-change → loading-model → ready (or error).
      await invoke(TAURI_COMMANDS.init, { config });
    } catch (err) {
      // Rust already emitted a structured `voxnap://error`; surface it
      // here too so awaiting callers don't lose context.
      // eslint-disable-next-line no-console
      console.error("[voxnap.tauri] voxnap_init failed:", err);
      this.emit("error", {
        code: "engine-internal",
        message: typeof err === "string" ? err : (err as Error)?.message ?? String(err),
        cause: err,
      });
      throw err;
    }
  }

  async listDevices(): Promise<AudioDevice[]> {
    try {
      return await invoke<AudioDevice[]>(TAURI_COMMANDS.listDevices);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[voxnap.tauri] voxnap_list_devices failed:", err);
      throw err;
    }
  }

  async listAccelerators(): Promise<AcceleratorInfo[]> {
    try {
      return await invoke<AcceleratorInfo[]>(TAURI_COMMANDS.listAccelerators);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[voxnap.tauri] voxnap_list_accelerators failed, falling back to CPU:",
        err,
      );
      // Fallback so the UI can always render something useful even when
      // the command isn't yet wired (older Rust binary).
      return [
        {
          id: "cpu",
          label: "CPU",
          backend: "cpu",
          available: true,
        },
      ];
    }
  }

  /**
   * Verbose accelerator diagnostic. Powers the "Diagnose NPU" button in
   * Settings → Compute. We swallow errors and synthesise a single
   * `failed` entry instead, so the modal always has *something* to
   * render — older Rust binaries that don't export the command yet
   * still produce a useful "command not registered" message.
   */
  async diagnoseAccelerators(): Promise<DiagnosticReport> {
    try {
      return await invoke<DiagnosticReport>(TAURI_COMMANDS.diagnoseAccelerators);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[voxnap.tauri] voxnap_diagnose_accelerators failed:", err);
      const message =
        typeof err === "string" ? err : (err as Error)?.message ?? String(err);
      return {
        platform: "unknown",
        compiledFeatures: [],
        entries: [
          {
            id: "ipc-error",
            label: "Tauri IPC",
            status: "failed",
            detail: `voxnap_diagnose_accelerators failed: ${message}. The desktop binary may be older than the UI; rebuild it (\`pnpm dev:desktop\` / \`pnpm build:desktop\`) to pick up the new diagnostic command.`,
          },
        ],
      };
    }
  }

  async start(deviceId?: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.info("[voxnap.tauri] start", { deviceId: deviceId ?? null });
    try {
      // Rust emits state-change → running.
      await invoke(TAURI_COMMANDS.start, { deviceId: deviceId ?? null });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[voxnap.tauri] voxnap_start failed:", err);
      this.emit("error", {
        code: "engine-internal",
        message: typeof err === "string" ? err : (err as Error)?.message ?? String(err),
        cause: err,
      });
      throw err;
    }
  }

  async stop(): Promise<void> {
    // eslint-disable-next-line no-console
    console.info("[voxnap.tauri] stop");
    try {
      // Rust emits state-change → ready.
      await invoke(TAURI_COMMANDS.stop);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[voxnap.tauri] voxnap_stop failed:", err);
      throw err;
    }
  }


  async dispose(): Promise<void> {
    try {
      // Rust emits state-change → disposed.
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
    this._state = "disposed";
  }
}
