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
//!   events    : voxnap://state-change, voxnap://segment,
//!               voxnap://audio-level, voxnap://error
//!
//! Drop a real model file into `<resourceDir>/models/ggml-<id>.bin` (or run
//! `pnpm fetch:model`) to enable transcription; without one, the pipeline
//! still streams audio-level events so the UI can confirm wiring.


mod accelerator;
mod audio;
mod commands;
mod error;
mod mel;
mod models;
mod onnx_engine;
mod state;
mod whisper;
mod whisper_tokens;

/// Entry point shared by both the desktop binary (`main.rs`) and the
/// mobile crate (`apps/mobile/src-tauri`).
///
/// We let `tauri_plugin_log` own the global logger; installing
/// `tracing_subscriber` on top of it would panic at startup with
/// "attempted to set a logger after the logging system was already
/// initialized". `tracing::info!` calls still flow through the plugin's
/// log shim, so we don't lose anything.
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
            commands::voxnap_list_accelerators,
            commands::voxnap_list_models,
            commands::voxnap_models_dir,
            commands::voxnap_download_model,
            commands::voxnap_cancel_download,
            commands::voxnap_delete_model,
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



