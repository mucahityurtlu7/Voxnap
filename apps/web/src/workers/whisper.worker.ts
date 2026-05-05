/// <reference lib="webworker" />
/**
 * Whisper Web Worker — STUB.
 *
 * This is the file the WasmEngine talks to. The wiring is complete; the
 * actual whisper.cpp WASM call is left as a TODO so the rest of the stack
 * can run end-to-end with the MockEngine until you're ready to drop in a
 * real WASM build.
 *
 * To finish the integration:
 *   1. Drop `whisper.wasm` and its JS glue (e.g. `libmain.js` from
 *      whisper.cpp/examples/whisper.wasm) into `public/whisper/`.
 *   2. importScripts(self.location.origin + "/whisper/libmain.js") at the top.
 *   3. Inside `init`, fetch the model bytes and call `Module.FS_createDataFile`
 *      then `Module.init("path-to-model")`.
 *   4. Inside `audio`, accumulate ~3-second chunks and call `Module.full_default`,
 *      then post `{ type: "segment", segment: { … } }` for each whisper segment.
 *
 * See: https://github.com/ggerganov/whisper.cpp/tree/master/examples/whisper.wasm
 */
import type {
  WasmWorkerInbound,
  WasmWorkerOutbound,
} from "@voxnap/core";

const post = (msg: WasmWorkerOutbound) => (self as unknown as Worker).postMessage(msg);

let initialized = false;
let pcmBuffer: Float32Array = new Float32Array(0);

self.onmessage = async (e: MessageEvent<WasmWorkerInbound>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init": {
        const modelUrl = msg.modelUrl;
        // ───────────────────────────────────────────────────────────────────
        // TODO(real-impl): load whisper.wasm here, fetch the model, initialise
        // the runtime. For now we just confirm we *could* fetch the model.
        // ───────────────────────────────────────────────────────────────────
        await fetch(modelUrl, { method: "HEAD" }).catch(() => {
          // Model not found is OK in stub mode; we log and continue.
          console.warn(
            `[voxnap.worker] model not found at ${modelUrl} — stub mode (no transcription).`,
          );
        });
        initialized = true;
        post({ type: "ready" });
        return;
      }

      case "audio": {
        if (!initialized) return;
        // Append incoming PCM to the rolling buffer.
        const incoming = msg.pcm;
        const merged = new Float32Array(pcmBuffer.length + incoming.length);
        merged.set(pcmBuffer, 0);
        merged.set(incoming, pcmBuffer.length);
        pcmBuffer = merged;

        // Once we have ~3 seconds (16k * 3 = 48000 samples), "transcribe".
        const CHUNK = 16000 * 3;
        if (pcmBuffer.length >= CHUNK) {
          const _slice = pcmBuffer.slice(0, CHUNK);
          pcmBuffer = pcmBuffer.slice(CHUNK);

          // ─────────────────────────────────────────────────────────────────
          // TODO(real-impl): call whisper.full_default(_slice) and emit each
          // returned segment. For now emit a placeholder so the UI shows
          // wiring is alive.
          // ─────────────────────────────────────────────────────────────────
          post({
            type: "segment",
            segment: {
              id: `stub-${Date.now()}`,
              text: "[whisper.wasm stub: drop libmain.js into public/whisper/ to enable]",
              startMs: 0,
              endMs: 3000,
              isFinal: true,
            },
          });
        }
        return;
      }

      case "flush": {
        pcmBuffer = new Float32Array(0);
        return;
      }

      case "dispose": {
        initialized = false;
        pcmBuffer = new Float32Array(0);
        return;
      }
    }
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
};

// Signal we're alive even before init is called (helps debug worker startup).
console.log("[voxnap.worker] booted");
