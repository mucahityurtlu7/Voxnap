/**
 * Tiny energy-based voice activity detector.
 *
 * Not as accurate as Silero VAD, but it has zero deps and zero latency,
 * which makes it a great default for the web build's chunker. Native
 * builds will swap this for a proper VAD inside Rust.
 */
export interface VadOptions {
  /** RMS threshold above which a frame is considered "speech". 0..1. */
  rmsThreshold?: number;
  /** Min consecutive ms below threshold before we declare end-of-speech. */
  hangoverMs?: number;
  /** Sample rate of incoming audio. */
  sampleRate?: number;
}

export interface VadFrameResult {
  isSpeech: boolean;
  rms: number;
  /** Becomes true on the frame where speech ends (silence locked-in). */
  endOfUtterance: boolean;
}

export class EnergyVad {
  private readonly threshold: number;
  private readonly hangoverMs: number;
  private readonly sampleRate: number;
  private silentMs = 0;
  private inSpeech = false;

  constructor(opts: VadOptions = {}) {
    this.threshold = opts.rmsThreshold ?? 0.02;
    this.hangoverMs = opts.hangoverMs ?? 500;
    this.sampleRate = opts.sampleRate ?? 16000;
  }

  process(frame: Float32Array): VadFrameResult {
    const rms = computeRms(frame);
    const frameMs = (frame.length / this.sampleRate) * 1000;
    let endOfUtterance = false;

    if (rms >= this.threshold) {
      this.inSpeech = true;
      this.silentMs = 0;
    } else if (this.inSpeech) {
      this.silentMs += frameMs;
      if (this.silentMs >= this.hangoverMs) {
        endOfUtterance = true;
        this.inSpeech = false;
        this.silentMs = 0;
      }
    }

    return { isSpeech: this.inSpeech, rms, endOfUtterance };
  }

  reset(): void {
    this.silentMs = 0;
    this.inSpeech = false;
  }
}

export function computeRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

export function computePeak(frame: Float32Array): number {
  let max = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = Math.abs(frame[i] ?? 0);
    if (v > max) max = v;
  }
  return max;
}
