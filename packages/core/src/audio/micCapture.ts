/**
 * Browser microphone capture helper.
 *
 * Wraps getUserMedia + AudioContext + AudioWorklet so the host app can do:
 *
 *   const cap = new MicCapture({ workletUrl, onFrame: pcm => engine.pushAudio(pcm) });
 *   await cap.start();   // prompts for permission
 *   ...
 *   await cap.stop();
 *
 * Frames arriving from the worklet are at the AudioContext's native rate
 * (often 48 kHz). They are resampled to 16 kHz before being handed to the
 * caller, since that's what whisper expects.
 */
import { resampleLinear } from "./resample.js";

const TARGET_RATE = 16000;

export interface MicCaptureOptions {
  /** URL pointing to the built `pcm-capture.worklet.js`. */
  workletUrl: string | URL;
  /** Called for every 20ms frame, resampled to 16 kHz mono float32. */
  onFrame: (pcm16k: Float32Array) => void;
  /** Called with raw RMS level (0..1) for VU meter UIs. */
  onLevel?: (rms: number, peak: number) => void;
  /** Specific input device id (from MediaDevices.enumerateDevices). */
  deviceId?: string;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(private readonly opts: MicCaptureOptions) {}

  get isRunning(): boolean {
    return this.ctx !== null;
  }

  async start(): Promise<void> {
    if (this.ctx) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.opts.deviceId ? { exact: this.opts.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(this.opts.workletUrl.toString());
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, "voxnap-pcm-capture");

    const ctxRate = this.ctx.sampleRate;
    this.worklet.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; sampleRate: number }>) => {
      const { pcm } = e.data;
      // Compute level on raw frame (cheap).
      if (this.opts.onLevel) {
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < pcm.length; i++) {
          const v = pcm[i] ?? 0;
          sum += v * v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        this.opts.onLevel(Math.sqrt(sum / pcm.length), peak);
      }
      const resampled = resampleLinear(pcm, ctxRate, TARGET_RATE);
      this.opts.onFrame(resampled);
    };

    this.source.connect(this.worklet);
    // Worklet does not need to be connected to destination — we don't play it.
  }

  async stop(): Promise<void> {
    try {
      this.worklet?.disconnect();
      this.source?.disconnect();
    } catch {
      /* noop */
    }
    this.worklet = null;
    this.source = null;

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    if (this.ctx) {
      await this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }
}
