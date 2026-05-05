/**
 * PCM capture AudioWorklet processor.
 *
 * This file runs INSIDE the AudioWorkletGlobalScope, so it has access to
 * `registerProcessor` and `currentFrame`/`sampleRate` globals — but NOT to
 * window/DOM. It must be self-contained: the bundler will emit it as a
 * separate file that the main thread loads via `audioContext.audioWorklet.addModule()`.
 *
 * It posts mono Float32Array chunks at the audio context's native rate
 * back to the main thread; resampling to 16 kHz is done on the main thread
 * to keep this hot path tiny.
 *
 * Build hint (Vite): place this file under `apps/web/src/workers/` and
 * import it with the `?worker&url` query so Vite emits it as a static asset.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  // 20ms frames at the context rate (~960 samples @ 48kHz, ~882 @ 44.1kHz)
  private readonly frameSize: number;
  private buffer: Float32Array;
  private fill = 0;

  constructor() {
    super();
    this.frameSize = Math.round((sampleRate * 20) / 1000);
    this.buffer = new Float32Array(this.frameSize);
  }

  override process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _params: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Downmix to mono.
    const ch0 = input[0]!;
    const ch1 = input[1]; // may be undefined
    const len = ch0.length;

    for (let i = 0; i < len; i++) {
      const sample = ch1 ? ((ch0[i] ?? 0) + (ch1[i] ?? 0)) * 0.5 : ch0[i] ?? 0;
      this.buffer[this.fill++] = sample;
      if (this.fill >= this.frameSize) {
        // Transfer the frame to main thread.
        const out = this.buffer;
        this.buffer = new Float32Array(this.frameSize);
        this.fill = 0;
        this.port.postMessage({ pcm: out, sampleRate }, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("voxnap-pcm-capture", PcmCaptureProcessor);

// AudioWorkletProcessor is provided by the runtime; declare it here so the
// file type-checks in isolation.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
