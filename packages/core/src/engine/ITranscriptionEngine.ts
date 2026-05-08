/**
 * Transcription engine abstraction.
 *
 * Every concrete engine (Tauri-native, WASM, mock) must implement this
 * interface. The UI layer ONLY consumes this interface — it must never
 * import a specific engine directly. This keeps platform code swappable
 * and the UI portable across desktop / mobile / web.
 */
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

export type EngineEventMap = {
  segment: TranscriptionSegment;
  "audio-level": AudioLevel;
  "state-change": EngineState;
  error: EngineError;
};

export type EngineEventName = keyof EngineEventMap;

export type EngineEventHandler<E extends EngineEventName> = (
  payload: EngineEventMap[E],
) => void;

export interface ITranscriptionEngine {
  /** Current lifecycle state. */
  readonly state: EngineState;

  /**
   * Load model + warm up. May download / decompress; can take seconds.
   * Idempotent: calling twice with same config is a no-op.
   */
  init(config: EngineConfig): Promise<void>;

  /** List available audio input devices. */
  listDevices(): Promise<AudioDevice[]>;

  /**
   * List the compute accelerators (NPU / GPU / CPU) the engine can target
   * on the current host. The UI uses this to render the Compute backend
   * picker in Settings and Onboarding so the user can confirm "yes, my
   * NPU is being used" or pin a specific backend.
   *
   * Optional: engines that don't expose a runtime backend choice can
   * leave this undefined; the UI then falls back to a static "CPU" entry.
   */
  listAccelerators?(): Promise<AcceleratorInfo[]>;

  /**
   * Verbose diagnostic for the accelerator pipeline. Powers the "Diagnose
   * NPU" UI: returns one row per probed channel (compile-features, EP
   * probes, OS-level NPU PnP scan, …) with status + free-form detail so
   * the user can actually act on a failed detection.
   *
   * Optional — engines that don't ship a hardware-detection layer (mock
   * / WASM) leave this undefined and the UI hides the diagnose button.
   */
  diagnoseAccelerators?(): Promise<DiagnosticReport>;

  /**
   * Begin capturing audio and emitting segments.
   * If `deviceId` is omitted the host's default input is used.
   */
  start(deviceId?: string): Promise<void>;

  /** Stop capture; finalises any pending segment. */
  stop(): Promise<void>;

  /**
   * Push externally-captured PCM (16 kHz mono float32) directly into the engine.
   * Used by the web build, where capture happens in an AudioWorklet rather
   * than inside the engine itself. Native engines may ignore this.
   */
  pushAudio?(pcm: Float32Array): void;

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<E extends EngineEventName>(event: E, handler: EngineEventHandler<E>): () => void;

  /** Release all resources. The engine cannot be reused after dispose. */
  dispose(): Promise<void>;
}

/**
 * Tiny event-emitter mixin used by all engines so they share a consistent
 * subscription contract. Kept private to this package; engines extend it.
 */
export class EngineEmitter {
  private readonly listeners: {
    [E in EngineEventName]?: Set<EngineEventHandler<E>>;
  } = {};

  protected emit<E extends EngineEventName>(event: E, payload: EngineEventMap[E]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as EngineEventHandler<E>)(payload);
      } catch (err) {
        // Never let a bad listener crash the engine loop.
        // eslint-disable-next-line no-console
        console.error(`[voxnap] listener for "${event}" threw:`, err);
      }
    }
  }

  on<E extends EngineEventName>(event: E, handler: EngineEventHandler<E>): () => void {
    let set = this.listeners[event] as Set<EngineEventHandler<E>> | undefined;
    if (!set) {
      set = new Set();
      (this.listeners as Record<string, unknown>)[event] = set;
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  protected disposeListeners(): void {
    for (const key of Object.keys(this.listeners)) {
      delete (this.listeners as Record<string, unknown>)[key];
    }
  }
}
