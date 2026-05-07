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

What you should see:

- **Desktop / mobile:** if a `ggml-*.bin` model is present (in `./models` or
  `<app-data>/models`) live transcription starts immediately; the waveform
  meter animates and segments stream in as you speak. If no model is found,
  the UI surfaces a `model-not-found` error toast and the audio meter still
  works so you can confirm capture wiring.
- **Web:** the first run downloads the matching ONNX Whisper checkpoint
  from the HuggingFace Hub via [transformers.js](https://github.com/xenova/transformers.js)
  (~40 MB for `base`, cached in IndexedDB after that) and then transcribes
  entirely on-device. No `ggml-*.bin` is required for the browser build.


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

## Releases & GPU acceleration

You **don't compile anything as a user**. Cut a release by tagging:

```bash
git tag v0.1.0 && git push --tags
```

That triggers three GitHub Actions workflows that build & publish
installers for every supported platform:

| Workflow                                                   | Produces                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| [`.github/workflows/release.yml`](./.github/workflows/release.yml) | `.dmg` (macOS arm64 & x64), `.msi`/`.exe` (Windows CPU + CUDA), `.AppImage`/`.deb` (Linux CPU + CUDA) |
| [`.github/workflows/mobile.yml`](./.github/workflows/mobile.yml)   | Android `.apk` + `.aab`, iOS `.ipa` (or simulator `.app.zip`) |
| [`.github/workflows/web.yml`](./.github/workflows/web.yml)         | Browser SPA deployed to GitHub Pages                          |

Hardware acceleration is wired in at build time — never asked of the
user:

- **macOS / iOS** — Metal + CoreML are auto-enabled via
  `[target.'cfg(target_os = "…")']` in
  [`apps/desktop/src-tauri/Cargo.toml`](./apps/desktop/src-tauri/Cargo.toml),
  so every Apple build ships ANE + GPU support without flags.
- **Windows / Linux** — vanilla artifact is pure CPU (works on every
  box). A separate "voxnap-…-cuda" artifact is shipped for NVIDIA users
  because a CUDA-linked binary requires the NVIDIA runtime DLLs to be
  present on the host.
- **Android** — CPU only (no whisper.cpp GPU/NPU path on Android yet).
- **Web** — whisper.wasm runs SIMD-accelerated CPU; WebGPU is detected
  at runtime by the engine when the bundle gains a WebGPU build.

Background on the engine-level abstraction (NPU / GPU / CPU picker)
lives in [`packages/core/src/types.ts`](./packages/core/src/types.ts) and
[`apps/desktop/src-tauri/src/accelerator.rs`](./apps/desktop/src-tauri/src/accelerator.rs).

## License

MIT.

[wcpp]: https://github.com/ggerganov/whisper.cpp
