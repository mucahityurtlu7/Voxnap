//! Application-level state shared across Tauri commands.
//!
//! We deliberately avoid putting `whisper-rs` types directly here so they can
//! be moved off-thread. The `Session` struct just owns join handles + a
//! shutdown signal; the heavy lifting lives inside the spawned tasks.

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::whisper::WhisperConfig;

/// Top-level state registered with `tauri::Builder::manage`.
#[derive(Default)]
pub struct AppState {
    pub session: Arc<Mutex<Option<Session>>>,
    pub config: Arc<Mutex<Option<WhisperConfig>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// One live transcription session. Created by `voxnap_start`, dropped by
/// `voxnap_stop` / `voxnap_dispose`.
pub struct Session {
    /// Tells both the audio + whisper tasks to wind down.
    pub shutdown: tokio::sync::watch::Sender<bool>,
    /// Capture task join handle (cpal stream lives on a dedicated thread).
    pub audio_handle: std::thread::JoinHandle<()>,
    /// Whisper inference task join handle (tokio task).
    pub whisper_handle: tokio::task::JoinHandle<()>,
}
