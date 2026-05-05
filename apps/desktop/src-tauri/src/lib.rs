//! Voxnap desktop backend.
//!
//! Architecture
//! ============
//!
//! ```text
//!  ┌──────────────┐  cpal callback   ┌──────────────────┐  rb push  ┌────────────┐
//!  │  microphone  │ ───────────────► │ AudioCaptureTask │ ────────► │ ring-buf   │
//!  └──────────────┘                  └──────────────────┘           └─────┬──────┘
//!                                                                         │ pop
//!                                                                         ▼
//!  ┌──────────────────────┐  events    ┌────────────────────────────────────────┐
//!  │   webview (React)    │ ◄────────  │  WhisperWorker (whisper-rs, sliding    │
//!  │  voxnap://transcript │            │  window, VAD, partial→final emission)  │
//!  └──────────────────────┘            └────────────────────────────────────────┘
//! ```
//!
//! The two long-running tasks (capture + whisper) live in `tokio` tasks and
//! talk through bounded channels so back-pressure is explicit.
//!
//! IPC contract (matches `packages/core/src/engine/TauriEngine.ts`):
//!
//!   commands  : voxnap_init, voxnap_start, voxnap_stop, voxnap_dispose,
//!               voxnap_list_devices
//!   events    : voxnap://state, voxnap://transcript, voxnap://error
//!
//! NOTE: this module currently ships an end-to-end *scaffold*. The cpal
//! capture loop is wired up and will stream PCM to the whisper task; the
//! whisper task itself emits stub segments until you drop a real model file
//! into `<resourceDir>/models/ggml-<id>.bin` (see README).

mod audio;
mod commands;
mod error;
mod state;
mod whisper;

/// Entry point shared by both the desktop binary (`main.rs`) and the
/// mobile crate (`apps/mobile/src-tauri`).
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::voxnap_init,
            commands::voxnap_start,
            commands::voxnap_stop,
            commands::voxnap_dispose,
            commands::voxnap_list_devices,
        ])
        .setup(|app| {
            tracing::info!(
                "Voxnap desktop {} starting",
                app.package_info().version
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,voxnap=debug")),
        )
        .try_init();
}
