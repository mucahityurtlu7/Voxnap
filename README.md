# Voxnap

> Privacy-first **live transcription** powered by [whisper.cpp][wcpp] —
> one React UI, three runtimes (desktop, mobile, browser).

```
┌────────────────────────────────────────────────────────────────────┐
│                        @voxnap/ui (React)                          │
│            useTranscription() ←→ ITranscriptionEngine              │
└──────────┬───────────────────┬────────────────────┬────────────────┘
           │                   │                    │
   ┌───────▼────────┐  ┌───────▼────────┐  ┌────────▼────────────┐
   │  TauriEngine   │  │  TauriEngine   │  │     WasmEngine       │
   │ (desktop: cpal │  │ (mobile: cpal  │  │ (web: AudioWorklet + │
   │ + whisper-rs)  │  │ + whisper-rs)  │  │  whisper.wasm)       │
   └────────────────┘  └────────────────┘  └─────────────────────┘
```

## Quick start

```bash
# Install JS deps (pnpm 9+).
pnpm install

# Pull a small whisper.cpp model (≈60 MB) into ./models
pnpm fetch:model                  # default: base.q5_1
pnpm fetch:model small.q5_1       # or pick another

# Run the desktop app (Windows / macOS / Linux):
pnpm dev:desktop

# Run the in-browser app:
pnpm dev:web

# Run mobile (requires Tauri Mobile prereqs: Xcode / Android SDK):
pnpm --filter @voxnap/mobile ios:dev
pnpm --filter @voxnap/mobile android:dev
```

The first launch with no model file will run a **stub** transcription so you
can verify the UI ↔ engine wiring is alive. Drop the `ggml-*.bin` into
`./models` (or run `pnpm fetch:model`) to enable real transcription.

## Repo layout

See [`AGENTS.md`](./AGENTS.md) for the full convention guide. TL;DR:

- `packages/core` — engines + audio utils (pure TS, no DOM/Tauri at the type level).
- `packages/ui` — React components, pages, hooks, Tailwind preset.
- `apps/desktop` — Tauri 2 shell with the native cpal + whisper-rs pipeline.
- `apps/mobile` — Tauri 2 Mobile, re-uses the desktop crate via path-dep.
- `apps/web` — Vite SPA with whisper.wasm + AudioWorklet.

## Why three engines?

Each runtime has a totally different audio + inference story:

| Concern        | Desktop / Mobile (Tauri)             | Browser (Wasm)                      |
| -------------- | ------------------------------------ | ----------------------------------- |
| Audio capture  | Rust `cpal` on a real-time thread    | `AudioWorkletNode` in the page      |
| Inference      | `whisper-rs` (FFI to whisper.cpp)    | `whisper.wasm` in a Web Worker      |
| Acceleration   | Metal / CUDA / OpenBLAS via Cargo    | WASM SIMD / WebGPU when available   |
| Models on disk | bundled or `<app-data>/models`       | `IndexedDB` cache from `/whisper/…` |
| Permissions    | Tauri capability files               | `getUserMedia` consent prompt       |

Hiding all of that behind one interface (`ITranscriptionEngine`) is what
keeps the UI a single React tree and the same `useTranscription` hook
working everywhere.

## Knowledge graph (graphify)

For a bird's-eye view of how engines, packages and apps connect — and to expose
that map to your AI assistant — Voxnap ships [graphify](https://github.com/safishamsi/graphify)
integration:

```bash
pnpm graph:install     # one-time (Python 3.10+)
pnpm graph             # builds graphify-out/graph.html + GRAPH_REPORT.md
```

Project-level MCP configs are committed for **VS Code**, **Antigravity**,
**Gemini CLI**, **Claude Code**, **Cursor** and **Windsurf**, so any of those
assistants can query the graph (`graphify-voxnap` server) the moment you open
the workspace. Full guide: [`docs/graphify.md`](./docs/graphify.md).

## License

MIT.

[wcpp]: https://github.com/ggerganov/whisper.cpp
