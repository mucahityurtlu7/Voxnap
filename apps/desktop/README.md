# @voxnap/desktop

Tauri 2 desktop shell. The frontend is a thin Vite + React entry that mounts
`@voxnap/ui` and injects a `TauriEngine`. All the heavy lifting happens in
`src-tauri/` (Rust):

```
src-tauri/
├─ Cargo.toml          ← whisper-rs + cpal + tokio
├─ tauri.conf.json
├─ capabilities/       ← Tauri 2 capability files (per-window perms)
└─ src/
   ├─ main.rs          ← `voxnap_desktop_lib::run()`
   ├─ lib.rs           ← Builder + plugin registration
   ├─ commands.rs      ← #[tauri::command] handlers (IPC surface)
   ├─ audio.rs         ← cpal capture + resample → ringbuf
   ├─ whisper.rs       ← whisper-rs worker (sliding window)
   ├─ state.rs         ← AppState + Session
   └─ error.rs         ← serializable error type
```

## Run

```bash
pnpm fetch:model            # one-time
pnpm dev:desktop            # equivalent to: tauri dev (from this folder)
```

## Hardware acceleration

End users **never** compile anything — they grab the installer for their
platform from the GitHub Release. The CI matrix
([`.github/workflows/release.yml`](../../.github/workflows/release.yml))
produces one artifact per (OS, accelerator) combination:

| Platform                 | Accelerator                | How it's enabled                          |
| ------------------------ | -------------------------- | ----------------------------------------- |
| macOS (Apple Silicon)    | Metal + CoreML (auto)      | `[target.'cfg(target_os = "macos")']` in `Cargo.toml` adds the features automatically. |
| macOS (Intel)            | Metal (auto)               | Same target-cfg block.                    |
| Windows / Linux (vanilla)| CPU                        | Default features = `[]` — runs everywhere.|
| Windows / Linux (NVIDIA) | CUDA                       | Separate matrix entry passes `--features cuda`. Shipped as a distinct "voxnap-…-cuda" installer; users with NVIDIA GPUs grab that one. |
| iOS                      | CoreML (auto)              | `[target.'cfg(target_os = "ios")']` block.|
| Android                  | CPU                        | No GPU/NPU path in whisper.cpp yet.       |

If you want to build locally with a non-default backend:

```bash
# Apple Silicon (already auto on macOS, just for parity)
pnpm --filter @voxnap/desktop tauri build -- --features metal

# NVIDIA — needs the CUDA Toolkit installed locally
pnpm --filter @voxnap/desktop tauri build -- --features cuda

# Faster CPU matmul (BLAS)
pnpm --filter @voxnap/desktop tauri build -- --features openblas
```

To cut a release for *every* OS at once: tag a commit with `vX.Y.Z` and
push — the `Release`, `Mobile Release` and `Web` workflows will produce
all installers and attach them to the GitHub Release.

## IPC contract

Commands (mirror `TauriEngine.ts`):

| Command               | Args                       | Returns                |
| --------------------- | -------------------------- | ---------------------- |
| `voxnap_init`         | `{ config: WhisperConfig}` | `()`                   |
| `voxnap_start`        | `{ deviceId?: string }`    | `()`                   |
| `voxnap_stop`         | —                          | `()`                   |
| `voxnap_dispose`      | —                          | `()`                   |
| `voxnap_list_devices` | —                          | `AudioDeviceInfo[]`    |

Events:

- `voxnap://state`      — `"idle" | "running" | "error"`
- `voxnap://transcript` — `EmittedSegment` (id, text, start_ms, end_ms, isFinal)
- `voxnap://error`      — `string`
