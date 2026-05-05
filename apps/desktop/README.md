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

`Cargo.toml` exposes feature flags for the whisper.cpp backends:

```bash
# Apple Silicon
pnpm --filter @voxnap/desktop tauri build --features metal

# NVIDIA
pnpm --filter @voxnap/desktop tauri build --features cuda

# CPU + faster matmul
pnpm --filter @voxnap/desktop tauri build --features openblas
```

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
