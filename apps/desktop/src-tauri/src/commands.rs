//! Tauri IPC commands. Each maps 1-to-1 to a method on
//! `TauriEngine` (see `packages/core/src/engine/TauriEngine.ts`).

use tauri::{AppHandle, Emitter, State};

use crate::audio::{self, AudioDeviceInfo};
use crate::error::{Error, Result};
use crate::state::{AppState, Session};
use crate::whisper::{self, WhisperConfig};

#[tauri::command]
pub async fn voxnap_init(
    state: State<'_, AppState>,
    config: WhisperConfig,
) -> Result<()> {
    *state.config.lock().await = Some(config);
    Ok(())
}

#[tauri::command]
pub async fn voxnap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    #[allow(non_snake_case)] deviceId: Option<String>,
) -> Result<()> {
    let mut session_slot = state.session.lock().await;
    if session_slot.is_some() {
        return Err(Error::AlreadyRunning);
    }

    let cfg = state
        .config
        .lock()
        .await
        .clone()
        .ok_or(Error::NotInitialised)?;

    // Capture: ~30 s of headroom in the ring buffer is plenty.
    let rb_capacity = (audio::TARGET_SAMPLE_RATE as usize) * 30;
    let (capture, consumer, _sr) =
        audio::start_capture(deviceId.as_deref(), rb_capacity)?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let whisper_handle = whisper::spawn(app.clone(), cfg, consumer, shutdown_rx);

    // Park the cpal stream on a dedicated OS thread; cpal's `Stream` is
    // !Send on some platforms, so we leak it into a thread that just waits
    // for the shutdown signal and drops it.
    let mut shutdown_rx_audio = shutdown_tx.subscribe();
    let audio_handle = std::thread::spawn(move || {
        // Block this thread until shutdown.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("audio runtime");
        rt.block_on(async {
            let _ = shutdown_rx_audio.changed().await;
        });
        capture.stop();
    });

    *session_slot = Some(Session {
        shutdown: shutdown_tx,
        audio_handle,
        whisper_handle,
    });

    let _ = app.emit("voxnap://state", "running");
    Ok(())
}

#[tauri::command]
pub async fn voxnap_stop(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let mut slot = state.session.lock().await;
    if let Some(session) = slot.take() {
        let _ = session.shutdown.send(true);
        // We don't .await the audio thread join (it's std::thread); just
        // detach. The whisper task will drop naturally.
        drop(session.audio_handle);
        let _ = session.whisper_handle.await;
    }
    let _ = app.emit("voxnap://state", "idle");
    Ok(())
}

#[tauri::command]
pub async fn voxnap_dispose(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    voxnap_stop(app, state.clone()).await?;
    *state.config.lock().await = None;
    Ok(())
}

#[tauri::command]
pub fn voxnap_list_devices() -> Result<Vec<AudioDeviceInfo>> {
    audio::list_devices()
}
