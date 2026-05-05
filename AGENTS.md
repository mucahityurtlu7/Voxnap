# AGENTS.md — Voxnap

> Conventions and constraints for any agent (human or AI) hacking on this repo.
> Read this before touching files. **Keep it short.**

## Mission

Voxnap is a **privacy-first live transcription** app powered by whisper.cpp,
running in the same React UI on **Windows / macOS / Linux (Tauri desktop)**,
**iOS / Android (Tauri mobile)** and **the browser (Vite SPA + whisper.wasm)**.

The whole architecture is built around one rule:

> **Anything platform-specific hides behind `ITranscriptionEngine`.**

If you find yourself adding `if (isTauri)` or `navigator.userAgent` checks
inside UI/business code, stop — push the branch into a new engine instead.

## Layout

```
voxnap/
├─ apps/
│  ├─ desktop/        Tauri 2 shell  (whisper-rs + cpal native pipeline)
│  ├─ mobile/         Tauri 2 Mobile (re-uses desktop crate via path-dep)
│  └─ web/            Vite SPA       (whisper.wasm + AudioWorklet, in-browser)
├─ packages/
│  ├─ core/           ITranscriptionEngine + Mock/Tauri/Wasm impls,
│  │                  audio utils (VAD, resample, mic capture), zustand store
│  └─ ui/             Shared React components, pages, hooks, Tailwind preset
├─ scripts/           Repo tooling (e.g. fetch-model.mjs)
├─ models/            ggml-*.bin (git-ignored)
└─ AGENTS.md          ← you are here
```

## Engine contract

`packages/core/src/engine/ITranscriptionEngine.ts` is the source of truth.
Three concrete engines today:

| Engine          | Where it runs            | Audio capture        | Inference          |
| --------------- | ------------------------ | -------------------- | ------------------ |
| `MockEngine`    | anywhere (tests/dev)     | none                 | scripted text      |
| `TauriEngine`   | `apps/desktop`, `mobile` | Rust `cpal`          | `whisper-rs` (FFI) |
| `WasmEngine`    | `apps/web`               | `AudioWorklet`       | `whisper.wasm`     |

All three emit `TranscriptionEvent` objects with the same `partial`/`final`
shape. The UI never knows which one is in use.

## Conventions

- **Package manager:** pnpm 9 + workspaces. Don't introduce npm/yarn lockfiles.
- **TS:** strict, ESM-only, `react-jsx`. Path aliases via `tsconfig.base.json`.
- **Lint/format:** Prettier (`.prettierrc.json`). No ESLint config yet — keep
  modules tiny and self-explanatory; we'll add it once we have real surface.
- **Rust:** `cargo fmt` / `clippy` clean, edition 2021. The desktop crate is
  `voxnap-desktop` and is *the* place where native whisper logic lives. The
  mobile crate is just a thin `pub fn run()` shim that calls into it.
- **Naming:** files in `packages/*/src` use `camelCase.ts`, components use
  `PascalCase.tsx`. One default export per component file.
- **Imports:** use the `@voxnap/*` workspace specifiers, never relative
  `../../packages/...` paths.
- **Side effects:** `packages/core` has `"sideEffects": false` — keep it that
  way (no top-level `console.log`, no module-level mutation).
- **Errors:** Rust commands return `Result<T, crate::error::Error>` so the
  JS layer always gets predictable string errors.

## Build & run

```bash
pnpm install
pnpm fetch:model              # downloads ggml-base.q5_1.bin into ./models

# Desktop (Tauri)
pnpm dev:desktop              # = pnpm --filter @voxnap/desktop tauri dev

# Web (whisper.wasm)
pnpm dev:web                  # serves apps/web on :5173

# Mobile
pnpm --filter @voxnap/mobile ios:dev
pnpm --filter @voxnap/mobile android:dev
```

## Knowledge graph

To get a bird's-eye view of how the engines, packages and apps connect, run:

```bash
pnpm graph:install     # one-time
pnpm graph             # builds graphify-out/
```

Then read `graphify-out/GRAPH_REPORT.md` for god nodes / surprising edges, or
open `graphify-out/graph.html`. The repo also ships project-level MCP configs
(VS Code, Antigravity, Gemini CLI, Claude Code, Cursor, Windsurf) so any of
those assistants can query the graph directly. See [`docs/graphify.md`](./docs/graphify.md).

## When in doubt

- Adding a feature that touches audio? It belongs in **`packages/core`** if
  it's pure logic, or behind an engine method if it crosses platforms.
- Adding UI? It almost always belongs in **`packages/ui`** so all three apps
  pick it up for free.
- Adding a Tauri command? Mirror it in `TauriEngine.ts` *and*
  `apps/desktop/src-tauri/src/commands.rs` in the same PR.
