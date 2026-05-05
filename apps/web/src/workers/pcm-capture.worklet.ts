/**
 * Local re-export of the @voxnap/core PCM capture worklet.
 *
 * Vite's `?worker&url` query needs a file path inside the app's own source
 * tree, so we keep a thin re-export here. The implementation lives in
 * `@voxnap/core/audio/worklet/pcm-capture.worklet.ts`.
 *
 * Keep this file's body identical to the source in core. It is duplicated
 * (rather than imported) on purpose: AudioWorkletGlobalScope cannot resolve
 * bare-package imports.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;

class PcmCaptureProcessor extends AudioWorkletProcessor {
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
    const ch0 = input[0]!;
    const ch1 = input[1];
    const len = ch0.length;
    for (let i = 0; i < len; i++) {
      const sample = ch1 ? ((ch0[i] ?? 0) + (ch1[i] ?? 0)) * 0.5 : ch0[i] ?? 0;
      this.buffer[this.fill++] = sample;
      if (this.fill >= this.frameSize) {
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

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
