/**
 * Web entry point.
 *
 * Picks an ASR engine based on `VITE_ENGINE`:
 *   - "wasm"  → WasmEngine + transformers.js whisper worker (default)
 *   - "mock"  → MockEngine (no model needed; useful for offline UI work)
 *
 * The WasmEngine path runs whisper entirely on-device via transformers.js;
 * the model is fetched from the HuggingFace Hub on first run and cached
 * in IndexedDB. No backend, no cloud — same privacy posture as the desktop
 * build.
 *
 * Set `VITE_MODEL=tiny`, `VITE_MODEL=base`, `VITE_MODEL=small`, etc. to
 * pick a checkpoint size. Defaults to `base.q5_1` (which maps to the ONNX
 * `Xenova/whisper-base` repo inside the worker).
 *
 * Summariser + session store are mock-first; both can be swapped without
 * touching any UI code.
 */
import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import {
  DEFAULT_MODEL,
  MicCapture,
  MockEngine,
  MockSummarizer,
  MemorySessionStore,
  MOCK_SESSIONS,
  WasmEngine,
  type ITranscriptionEngine,
  type WhisperModelId,
} from "@voxnap/core";
import {
  App,
  EngineProvider,
  SummarizerProvider,
  SessionsBootstrap,
  ToastProvider,
} from "@voxnap/ui";

// Vite emits the worklet as a static asset, returning its URL.
import workletUrl from "./workers/pcm-capture.worklet.ts?worker&url";

function createEngine(): ITranscriptionEngine {
  const which = (import.meta.env.VITE_ENGINE ?? "wasm") as "mock" | "wasm";

  if (which === "wasm") {
    const modelId = (import.meta.env.VITE_MODEL ?? DEFAULT_MODEL) as WhisperModelId;
    // The transformers.js worker doesn't actually need this URL — it
    // resolves the model itself from the HuggingFace Hub — but we keep
    // the field populated for future swap-in of a local ggml-* file.
    const modelUrl = `/whisper/ggml-${modelId}.bin`;

    const engine = new WasmEngine({
      modelUrl,
      workerFactory: () =>
        new Worker(new URL("./workers/whisper.worker.ts", import.meta.url), { type: "module" }),
    });

    // The web build owns microphone capture and pushes PCM frames to
    // the engine. Lifecycle is driven entirely by the engine state.
    let capture: MicCapture | null = null;
    engine.on("state-change", async (s) => {
      if (s === "running" && !capture) {
        capture = new MicCapture({
          workletUrl,
          onFrame: (pcm) => engine.pushAudio?.(pcm),
          onLevel: (rms, peak) => engine.reportLevel(rms, peak),
        });
        try {
          await capture.start();
        } catch (err) {
          console.error("[voxnap] mic capture failed", err);
          capture = null;
        }
      } else if (s !== "running" && capture) {
        await capture.stop();
        capture = null;
      }
    });

    return engine;
  }

  return new MockEngine();
}

const engine = createEngine();
const summarizer = new MockSummarizer();
const sessionStore = new MemorySessionStore({ seed: MOCK_SESSIONS });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <SummarizerProvider summarizer={summarizer}>
        <SessionsBootstrap store={sessionStore}>
          <EngineProvider engine={engine}>
            <App router="browser" />
          </EngineProvider>
        </SessionsBootstrap>
      </SummarizerProvider>
    </ToastProvider>
  </React.StrictMode>,
);
