/**
 * MockEngine — pure JS, no audio, no model.
 *
 * Use cases:
 *   • CI / unit tests
 *   • UI development without microphone access
 *   • Demo mode
 *
 * Emits a scripted sequence of interim → final segments on a timer
 * so the UI shows realistic streaming behaviour.
 */
import { nanoid } from "nanoid";

import type { AudioDevice, EngineConfig, EngineState } from "../types.js";
import { EngineEmitter, type ITranscriptionEngine } from "./ITranscriptionEngine.js";

const SCRIPT: string[] = [
  "Voxnap is a cross-platform live transcription app.",
  "It runs on Windows, macOS, Linux, Android, iOS and the web.",
  "On native targets it uses whisper.cpp through Rust.",
  "On the web it runs whisper as WebAssembly inside a worker.",
  "The UI is shared across all platforms.",
];

export class MockEngine extends EngineEmitter implements ITranscriptionEngine {
  private _state: EngineState = "idle";
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private scriptIndex = 0;
  private currentSegmentId: string | null = null;
  private currentTyped = "";

  get state(): EngineState {
    return this._state;
  }

  private setState(next: EngineState): void {
    this._state = next;
    this.emit("state-change", next);
  }

  async init(_config: EngineConfig): Promise<void> {
    this.setState("loading-model");
    // Simulate model load latency.
    await new Promise((r) => setTimeout(r, 250));
    this.setState("ready");
  }

  async listDevices(): Promise<AudioDevice[]> {
    return [{ id: "mock", label: "Mock microphone", isDefault: true }];
  }

  async start(_deviceId?: string): Promise<void> {
    if (this._state === "running") return;
    this.startedAt = Date.now();
    this.scriptIndex = 0;
    this.setState("running");
    this.tick(); // immediate kick-off
    this.timer = setInterval(() => this.tick(), 120);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Finalise any pending segment.
    if (this.currentSegmentId && this.currentTyped) {
      this.emitSegment(this.currentTyped, true);
    }
    this.currentSegmentId = null;
    this.currentTyped = "";
    this.setState("ready");
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.disposeListeners();
    this.setState("disposed");
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private tick(): void {
    // Emit a fake audio level so the UI's waveform animates.
    this.emit("audio-level", {
      rms: 0.1 + Math.random() * 0.4,
      peak: 0.3 + Math.random() * 0.6,
      at: Date.now(),
    });

    const phrase = SCRIPT[this.scriptIndex];
    if (!phrase) {
      // Loop the script for long sessions.
      this.scriptIndex = 0;
      this.currentSegmentId = null;
      this.currentTyped = "";
      return;
    }

    if (!this.currentSegmentId) {
      this.currentSegmentId = nanoid(8);
      this.currentTyped = "";
    }

    if (this.currentTyped.length < phrase.length) {
      this.currentTyped = phrase.slice(0, this.currentTyped.length + 2);
      this.emitSegment(this.currentTyped, false);
    } else {
      this.emitSegment(this.currentTyped, true);
      this.scriptIndex += 1;
      this.currentSegmentId = null;
      this.currentTyped = "";
    }
  }

  private emitSegment(text: string, isFinal: boolean): void {
    if (!this.currentSegmentId) return;
    const now = Date.now() - this.startedAt;
    this.emit("segment", {
      id: this.currentSegmentId,
      text,
      startMs: Math.max(0, now - 1500),
      endMs: now,
      isFinal,
      confidence: 0.92,
      language: "en",
    });
  }
}
