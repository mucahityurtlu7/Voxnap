/**
 * Web entry point.
 *
 * Picks an ASR engine based on `VITE_ENGINE`:
 *   - "mock"  → MockEngine (default in dev — no model needed)
 *   - "wasm"  → WasmEngine + whisper worker + microphone capture
 *
 * Set VITE_ENGINE=wasm in `.env.local` (or your shell) once you've placed
 * a whisper model under `public/whisper/ggml-<modelId>.bin`. Use:
 *
 *   pnpm fetch:model base.q5_1
 *
 * which writes to `apps/web/public/whisper/ggml-base.q5_1.bin`.
 *
 * Summariser + session store are mock-first; both can be swapped without
 * touching any UI code.
 */
import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import {
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
  const which = (import.meta.env.VITE_ENGINE ?? "mock") as "mock" | "wasm";

  if (which === "wasm") {
    const modelId = (import.meta.env.VITE_MODEL ?? "base.q5_1") as WhisperModelId;
    const modelUrl = `/whisper/ggml-${modelId}.bin`;

    const engine = new WasmEngine({
      modelUrl,
      workerFactory: () =>
        new Worker(new URL("./workers/whisper.worker.ts", import.meta.url), { type: "module" }),
    });

    // The web build owns microphone capture and pushes PCM frames to the engine.
    let capture: MicCapture | null = null;
    engine.on("state-change", async (s) => {
      if (s === "running" && !capture) {
        capture = new MicCapture({
          workletUrl,
          onFrame: (pcm) => engine.pushAudio?.(pcm),
          onLevel: (rms, peak) =>
            // Mirror level back through the engine's emitter so UI gets it.
            (engine as unknown as { emit: (e: string, p: unknown) => void }).emit?.(
              "audio-level",
              { rms, peak, at: Date.now() },
            ),
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
