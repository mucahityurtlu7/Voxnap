# @voxnap/core

Pure-TS heart of Voxnap. **No DOM, no Tauri imports at the type level.**
Three things live here:

1. **`engine/`** — `ITranscriptionEngine` + `MockEngine`, `TauriEngine`,
   `WasmEngine`. Pick one in your app entry, wrap with `EngineProvider`,
   forget about platform from then on.
2. **`audio/`** — VAD, resampling, mic capture helpers, the
   `pcm-capture.worklet.ts` source. Used by `WasmEngine` and re-exported for
   any other browser-side use.
3. **`store/`** — Zustand store that aggregates `TranscriptionEvent`s into
   `Segment[]` and tracks `EngineState`.

Add a new platform → add a new engine that implements the contract. Don't
add platform branches in the UI.
