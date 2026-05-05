/**
 * WasmEngine — runs whisper.cpp compiled to WebAssembly inside a Worker.
 *
 * Architecture:
 *   ┌──────────────────────────┐    pushAudio (Float32Array, 16k mono)
 *   │  Main thread / UI        │ ─────────────────────────────────────►
 *   │   • AudioWorklet capture │                                       │
 *   │   • WasmEngine façade    │ ◄───── postMessage("segment", …) ─────┘
 *   └──────────────────────────┘
 *                  ▲
 *                  │ creates
 *                  ▼
 *           Web Worker
 *             • loads whisper.wasm
 *             • runs inference
 *
 * The actual worker (`apps/web/src/workers/whisper.worker.ts`) is provided
 * by the web app — this class only knows how to talk to it. Each app injects
 * its worker via the `WorkerFactory` so we don't bake bundler-specific
 * URL imports into the shared core package.
 */
import { nanoid } from "nanoid";

import type { AudioDevice, EngineConfig, EngineState, TranscriptionSegment } from "../types.js";
import { EngineEmitter, type ITranscriptionEngine } from "./ITranscriptionEngine.js";

/** Messages sent from main thread to worker. */
export type WasmWorkerInbound =
  | { type: "init"; config: EngineConfig; modelUrl: string }
  | { type: "audio"; pcm: Float32Array }
  | { type: "flush" }
  | { type: "dispose" };

/** Messages sent from worker back to main thread. */
export type WasmWorkerOutbound =
  | { type: "ready" }
  | { type: "segment"; segment: TranscriptionSegment }
  | { type: "error"; message: string };

/**
 * Each web app supplies its own worker factory because bundlers handle
 * Worker URLs differently (Vite uses `new Worker(new URL(...), { type: "module" })`).
 */
export type WorkerFactory = () => Worker;

export interface WasmEngineOptions {
  workerFactory: WorkerFactory;
  /**
   * URL where the whisper model file (ggml-*.bin) can be fetched.
   * Typically `/whisper/ggml-base.q5_1.bin` served from `public/`.
   */
  modelUrl: string;
}

export class WasmEngine extends EngineEmitter implements ITranscriptionEngine {
  private _state: EngineState = "idle";
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(private readonly opts: WasmEngineOptions) {
    super();
  }

  get state(): EngineState {
    return this._state;
  }

  private setState(next: EngineState): void {
    this._state = next;
    this.emit("state-change", next);
  }

  async init(config: EngineConfig): Promise<void> {
    if (this.worker) return; // idempotent
    this.setState("loading-model");

    this.worker = this.opts.workerFactory();
    this.worker.onmessage = (e: MessageEvent<WasmWorkerOutbound>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      this.emit("error", {
        code: "engine-internal",
        message: `Worker error: ${e.message}`,
        cause: e,
      });
    };

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.worker.postMessage({
      type: "init",
      config,
      modelUrl: this.opts.modelUrl,
    } satisfies WasmWorkerInbound);

    await this.readyPromise;
    this.setState("ready");
  }

  async listDevices(): Promise<AudioDevice[]> {
    // Browser audio device enumeration belongs to the host (the web app),
    // not the engine. We expose a sensible default here.
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({
          id: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
          isDefault: d.deviceId === "default",
        }));
    }
    return [{ id: "default", label: "Default microphone", isDefault: true }];
  }

  async start(_deviceId?: string): Promise<void> {
    // The web host is responsible for turning the mic on and calling
    // pushAudio(). We just transition state.
    this.setState("running");
  }

  async stop(): Promise<void> {
    this.worker?.postMessage({ type: "flush" } satisfies WasmWorkerInbound);
    this.setState("ready");
  }

  pushAudio(pcm: Float32Array): void {
    if (!this.worker) return;
    // Transfer the underlying buffer to avoid copy.
    this.worker.postMessage({ type: "audio", pcm } satisfies WasmWorkerInbound, [pcm.buffer]);
  }

  async dispose(): Promise<void> {
    this.worker?.postMessage({ type: "dispose" } satisfies WasmWorkerInbound);
    this.worker?.terminate();
    this.worker = null;
    this.disposeListeners();
    this.setState("disposed");
  }

  // ---------------------------------------------------------------------------
  // worker message handler
  // ---------------------------------------------------------------------------

  private onWorkerMessage(msg: WasmWorkerOutbound): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        return;
      case "segment":
        this.emit("segment", { ...msg.segment, id: msg.segment.id || nanoid(8) });
        return;
      case "error":
        this.emit("error", { code: "engine-internal", message: msg.message });
        this.readyReject?.(new Error(msg.message));
        this.readyReject = null;
        this.readyResolve = null;
        return;
    }
  }
}
