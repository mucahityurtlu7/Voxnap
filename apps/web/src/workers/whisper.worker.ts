/// <reference lib="webworker" />
/**
 * Whisper Web Worker — real implementation using `@xenova/transformers`
 * (a.k.a. transformers.js).
 *
 * Why transformers.js?
 *   • Drop-in: no manual `whisper.wasm` build pipeline needed.
 *   • Models are fetched from the HuggingFace Hub on demand and cached
 *     in IndexedDB by the library itself.
 *   • Runs on WASM SIMD by default and on WebGPU when available — fast
 *     enough for live transcription with the `tiny`/`base` Whisper sizes.
 *
 * Streaming strategy (mirrors the Rust desktop pipeline):
 *   • Accumulate ~`WINDOW_SECS` of 16 kHz mono float32 PCM.
 *   • Run the pipeline on the latest window each `STEP_SECS`.
 *   • Emit each whisper segment with a stable id derived from its absolute
 *     start time. Once a segment's end-time falls behind the *next* window,
 *     re-emit it with `isFinal: true`. The store keys on id, so partial →
 *     final is a clean replace.
 *
 * Inbound / outbound message shapes are imported from @voxnap/core so the
 * contract with `WasmEngine` stays a single source of truth.
 */
import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@xenova/transformers";
import type {
  EngineConfig,
  TranscriptionSegment,
  WasmWorkerInbound,
  WasmWorkerOutbound,
  WhisperModelId,
} from "@voxnap/core";

// transformers.js auto-loads its WASM binaries from a CDN by default. That's
// fine for development, but worth pinning for production deploys.
env.allowLocalModels = false;
env.useBrowserCache = true;

const post = (msg: WasmWorkerOutbound) =>
  (self as unknown as Worker).postMessage(msg);

function reportError(scope: string, err: unknown): void {
  const e = err as Error;
  const message = `[${scope}] ${e?.message ?? String(err)}`;
  // Log to the worker console with the full stack so DevTools shows where
  // it actually blew up. The main thread only gets the message string.
  // eslint-disable-next-line no-console
  console.error("[voxnap.worker]", message, e?.stack ?? err);
  post({ type: "error", message });
}

self.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("[voxnap.worker] uncaught error", e.error ?? e.message, e);
  post({
    type: "error",
    message: `[uncaught] ${e.message ?? String(e.error ?? e)}`,
  });
});

self.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.error("[voxnap.worker] unhandled promise rejection", e.reason);
  post({
    type: "error",
    message: `[unhandledrejection] ${
      (e.reason as Error)?.message ?? String(e.reason)
    }`,
  });
});


// Map our internal `WhisperModelId` (whisper.cpp ggml ids) to the matching
// transformers.js Whisper checkpoints. Quantized ggml variants like "q5_1"
// don't have a direct equivalent in the ONNX hub, so we strip the suffix
// and map by base size.
const MODEL_HUB: Record<string, string> = {
  tiny: "Xenova/whisper-tiny",
  "tiny.en": "Xenova/whisper-tiny.en",
  base: "Xenova/whisper-base",
  "base.en": "Xenova/whisper-base.en",
  small: "Xenova/whisper-small",
  "small.en": "Xenova/whisper-small.en",
  medium: "Xenova/whisper-medium",
};

function resolveModelRepo(id: WhisperModelId | string): string {
  // Drop quantization suffix (".q5_1", ".q8_0", …) — transformers.js
  // ships its own quantized files.
  const base = id.replace(/\.q[0-9_]+$/i, "");
  return MODEL_HUB[base] ?? MODEL_HUB.base!;
}

const SAMPLE_RATE = 16000;
const WINDOW_SECS = 6;
const STEP_SECS = 1.5;
const MIN_SPEECH_RMS = 0.012;

const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECS;
const STEP_SAMPLES = Math.round(SAMPLE_RATE * STEP_SECS);

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let inferenceLanguage: string | undefined;
let translate = false;
let busy = false;

// Rolling PCM buffer + bookkeeping for the absolute timeline.
let buffer: Float32Array = new Float32Array(0);
let consumedOffsetSamples = 0; // samples that have slid off the front
const finalized = new Set<string>();
const lastPartialText = new Map<string, string>();

self.onmessage = async (e: MessageEvent<WasmWorkerInbound>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init":
        await handleInit(msg.config);
        return;
      case "audio":
        await handleAudio(msg.pcm);
        return;
      case "flush":
        flush();
        return;
      case "dispose":
        dispose();
        return;
    }
  } catch (err) {
    reportError(`onmessage:${msg?.type ?? "unknown"}`, err);
  }
};

async function handleInit(config: EngineConfig): Promise<void> {
  const repo = resolveModelRepo(config.modelId);
  inferenceLanguage = config.language && config.language !== "auto"
    ? config.language
    : undefined;
  translate = !!config.translate;

  // eslint-disable-next-line no-console
  console.info(
    `[voxnap.worker] loading model "${repo}" (modelId=${config.modelId}, lang=${
      inferenceLanguage ?? "auto"
    }, translate=${translate})`,
  );

  try {
    // `quantized: true` selects the int8/q4 variant when available, which
    // is roughly 4× smaller and noticeably faster for live use.
    asr = (await pipeline("automatic-speech-recognition", repo, {
      quantized: true,
      progress_callback: (info: unknown) => {
        const p = info as {
          status?: string;
          file?: string;
          progress?: number;
        };
        if (p?.status === "progress" && typeof p.progress === "number") {
          // eslint-disable-next-line no-console
          console.debug(
            `[voxnap.worker] ${p.file ?? "?"} ${p.progress.toFixed(1)}%`,
          );
        } else if (p?.status) {
          // eslint-disable-next-line no-console
          console.info(
            `[voxnap.worker] pipeline:${p.status}${
              p.file ? ` (${p.file})` : ""
            }`,
          );
        }
      },
    })) as AutomaticSpeechRecognitionPipeline;
  } catch (err) {
    // Surface the real reason the pipeline failed (CORS, 404, OOM, …)
    // rather than the generic "Engine error" the UI ends up showing.
    reportError("pipeline.load", err);
    throw err;
  }

  // eslint-disable-next-line no-console
  console.info("[voxnap.worker] model loaded, ready");
  post({ type: "ready" });
}


async function handleAudio(pcm: Float32Array): Promise<void> {
  if (!asr) return;
  // Append incoming PCM (assumed already 16k mono float32) to the buffer.
  const merged = new Float32Array(buffer.length + pcm.length);
  merged.set(buffer, 0);
  merged.set(pcm, buffer.length);
  buffer = merged;

  // Run inference at most once at a time; if we're behind, drop frames
  // *before* the latest window so we always work on the freshest audio.
  if (busy) return;
  if (buffer.length < WINDOW_SAMPLES) return;

  busy = true;
  try {
    await runWindow();
  } finally {
    busy = false;
  }

  // Slide window forward by STEP_SAMPLES (only if we have enough overlap).
  if (buffer.length >= WINDOW_SAMPLES + STEP_SAMPLES) {
    buffer = buffer.slice(STEP_SAMPLES);
    consumedOffsetSamples += STEP_SAMPLES;
  }
}

async function runWindow(): Promise<void> {
  if (!asr) return;
  const windowStartInBuf = buffer.length - WINDOW_SAMPLES;
  const window = buffer.subarray(windowStartInBuf);
  const windowStartAbsSamples = consumedOffsetSamples + windowStartInBuf;
  const windowStartAbsMs = Math.round(
    (windowStartAbsSamples * 1000) / SAMPLE_RATE,
  );

  // Cheap energy gate: skip whisper on near-silence to save CPU and
  // avoid the model hallucinating on background noise.
  const rms = computeRms(window);
  if (rms < MIN_SPEECH_RMS) return;

  // Whisper itself wants a Float32Array; transformers.js calls it `audio`.
  // We ask for word-level timestamps so we get useful segment boundaries.
  // Some model checkpoints reject `language: undefined`, so build the
  // params object lazily.
  const params: Record<string, unknown> = {
    chunk_length_s: WINDOW_SECS,
    return_timestamps: true,
  };
  if (inferenceLanguage) params.language = inferenceLanguage;
  if (translate) params.task = "translate";

  const result = (await asr(window, params)) as WhisperPipelineResult;
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];

  // After the upcoming slide, the window starts here.
  const nextWindowStartAbsMs = windowStartAbsMs + STEP_SECS * 1000;

  if (chunks.length === 0 && typeof result?.text === "string") {
    // Some smaller models don't return per-chunk timestamps. Emit one
    // segment spanning the whole window in that case.
    emitSegment({
      windowStartAbsMs,
      nextWindowStartAbsMs,
      relStartMs: 0,
      relEndMs: WINDOW_SECS * 1000,
      text: result.text,
    });
    return;
  }

  for (const c of chunks) {
    const [t0s, t1s] = c.timestamp ?? [0, WINDOW_SECS];
    const relStartMs = Math.round((t0s ?? 0) * 1000);
    const relEndMs = Math.round((t1s ?? t0s ?? WINDOW_SECS) * 1000);
    emitSegment({
      windowStartAbsMs,
      nextWindowStartAbsMs,
      relStartMs,
      relEndMs,
      text: c.text ?? "",
    });
  }
}

function emitSegment(args: {
  windowStartAbsMs: number;
  nextWindowStartAbsMs: number;
  relStartMs: number;
  relEndMs: number;
  text: string;
}): void {
  const text = (args.text ?? "").trim();
  if (!text) return;

  const absStart = args.windowStartAbsMs + args.relStartMs;
  const absEnd = args.windowStartAbsMs + args.relEndMs;
  const id = `seg-${absStart}`;

  if (finalized.has(id)) return;

  const isFinal = absEnd <= args.nextWindowStartAbsMs;

  if (!isFinal) {
    if (lastPartialText.get(id) === text) return;
    lastPartialText.set(id, text);
  } else {
    lastPartialText.delete(id);
    finalized.add(id);
  }

  const seg: TranscriptionSegment = {
    id,
    text,
    startMs: absStart,
    endMs: absEnd,
    isFinal,
    language: inferenceLanguage,
  };
  post({ type: "segment", segment: seg });
}

function flush(): void {
  buffer = new Float32Array(0);
  consumedOffsetSamples = 0;
  finalized.clear();
  lastPartialText.clear();
}

function dispose(): void {
  flush();
  asr = null;
}

function computeRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

// transformers.js Whisper output shape (loosely typed; library doesn't
// publish a precise interface).
interface WhisperPipelineResult {
  text?: string;
  chunks?: Array<{
    text?: string;
    timestamp?: [number | null, number | null];
  }>;
}

console.log("[voxnap.worker] booted");
