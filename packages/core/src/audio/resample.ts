/**
 * Linear-interpolation downsampler/upsampler.
 *
 * Whisper expects 16 kHz mono float32. Browsers usually capture at the
 * AudioContext's native rate (44.1 / 48 kHz) so we resample on the way out
 * of the AudioWorklet. Quality is "good enough" for speech; for high-fidelity
 * music you'd want a polyphase resampler.
 */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcF = i * ratio;
    const srcI = Math.floor(srcF);
    const frac = srcF - srcI;
    const a = input[srcI] ?? 0;
    const b = input[srcI + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Downmix interleaved (or planar) multi-channel to mono by averaging.
 * `channels` may be:
 *   • a single Float32Array (already mono, returned as-is)
 *   • an array of Float32Array, one per channel (planar — typical Web Audio)
 */
export function toMono(channels: Float32Array | Float32Array[]): Float32Array {
  if (channels instanceof Float32Array) return channels;
  if (channels.length === 1) return channels[0]!;
  const len = channels[0]!.length;
  const out = new Float32Array(len);
  const inv = 1 / channels.length;
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) sum += channels[c]![i] ?? 0;
    out[i] = sum * inv;
  }
  return out;
}
