//! Tauri IPC commands. Each maps 1-to-1 to a method on
//! `TauriEngine` (see `packages/core/src/engine/TauriEngine.ts`).
//!
//! Lifecycle / events:
//!   • `voxnap_init`   → emits `voxnap://state-change` `loading-model` then `ready`
//!   • `voxnap_start`  → emits `voxnap://state-change` `running`
//!   • `voxnap_stop`   → emits `voxnap://state-change` `ready`
//!   • `voxnap_dispose`→ emits `voxnap://state-change` `disposed`
//!
//! Event names match the constants in `TauriEngine.ts`. Do not rename one
//! side without updating the other.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::accelerator::{self, AcceleratorInfo};
use crate::audio::{self, AudioDeviceInfo};
use crate::error::{Error, Result};
use crate::models::{self, ModelInfo};
use crate::onnx_engine::{self, OnnxConfig};
use crate::state::{AppState, Session};
use crate::whisper::{self, WhisperConfig};

/// Decide which inference pipeline (`whisper-cpp` vs `onnx`) should serve
/// the user's `compute_backend` choice.
///
/// We ask `accelerator::detect()` what each bucket maps to and look up the
/// matching `provider` field. That way the pipeline choice is driven by
/// the *runtime probe* rather than a hard-coded table — a build with
/// `--features ort-cuda` but no `--features cuda` will dispatch CUDA
/// requests to the ONNX path automatically, and vice versa.
///
/// Falls back to `"whisper-cpp"` if no matching accelerator is detected
/// (which is also the legacy behaviour).
fn pick_provider(compute_backend: Option<&str>) -> &'static str {
    let want = compute_backend.unwrap_or("auto");
    if want == "cpu" || want == "auto" {
        // CPU + auto stay on whisper.cpp because that is the more mature
        // pipeline today (beam search, partial emissions, KV cache). The
        // ONNX path takes over the moment the user pins a specific
        // accelerator that whisper.cpp can't serve.
        return "whisper-cpp";
    }

    // Look for the *first available* row matching the requested bucket.
    // Each `AcceleratorInfo.id` is "npu" / "gpu" / "cpu", so we filter to
    // the user's bucket and pick the first one with `available = true`.
    for a in accelerator::detect() {
        if a.id == want && a.available {
            return a.provider;
        }
    }
    // Bucket has no available accelerator (e.g. user picked "npu" on a
    // build without any ORT EP). whisper.cpp will silently fall back to
    // CPU — same observed behaviour as before this dispatcher landed.
    "whisper-cpp"
}

/// Convert the JS-side WhisperConfig into the OnnxConfig the parallel
/// pipeline expects. The two configs were intentionally given identical
/// JSON shapes so this is mostly field-by-field.
fn whisper_to_onnx(cfg: &WhisperConfig) -> OnnxConfig {
    OnnxConfig {
        model_id: cfg.model_id.clone(),
        language: cfg.language.clone(),
        model_dir: cfg.model_dir.clone(),
        translate: cfg.translate,
        threads: cfg.threads,
        compute_backend: cfg.compute_backend.clone(),
    }
}

const EV_STATE: &str = "voxnap://state-change";
const EV_ERROR: &str = "voxnap://error";

#[derive(Debug, Clone, Serialize)]
struct EngineErrorPayload {
    code: &'static str,
    message: String,
}

/// Validate the model file is reachable up-front so the UI can fail fast
/// rather than discover the problem mid-recording.
#[tauri::command]
pub async fn voxnap_init(
    app: AppHandle,
    state: State<'_, AppState>,
    config: WhisperConfig,
) -> Result<()> {
    tracing::info!(
        model_id = %config.model_id,
        language = %config.language,
        translate = config.translate,
        "voxnap_init"
    );
    let _ = app.emit(EV_STATE, "loading-model");

    // Probe the model file so callers get an actionable error here, not
    // 5 seconds into a recording.
    if let Err(e) = whisper::resolve_model_path(&app, &config) {
        tracing::error!("voxnap_init: model not found: {e}");
        let _ = app.emit(
            EV_ERROR,
            EngineErrorPayload {
                code: "model-not-found",
                message: e.to_string(),
            },
        );
        let _ = app.emit(EV_STATE, "error");
        return Err(e);
    }

    *state.config.lock().await = Some(config);
    let _ = app.emit(EV_STATE, "ready");
    tracing::info!("voxnap_init: ready");
    Ok(())
}


#[tauri::command]
pub async fn voxnap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    #[allow(non_snake_case)] deviceId: Option<String>,
) -> Result<()> {
    tracing::info!(device_id = ?deviceId, "voxnap_start");
    let mut session_slot = state.session.lock().await;
    if session_slot.is_some() {
        tracing::warn!("voxnap_start called while a session is already running");
        return Err(Error::AlreadyRunning);
    }

    let cfg = state
        .config
        .lock()
        .await
        .clone()
        .ok_or_else(|| {
            tracing::error!("voxnap_start: engine not initialised — call voxnap_init first");
            Error::NotInitialised
        })?;

    // Capture: ~30 s of headroom in the ring buffer is plenty.
    let rb_capacity = (audio::TARGET_SAMPLE_RATE as usize) * 30;
    let (capture, consumer, _sr) = match audio::start_capture(deviceId.as_deref(), rb_capacity) {
        Ok(x) => x,
        Err(e) => {
            tracing::error!("voxnap_start: audio capture failed: {e}");
            let _ = app.emit(
                EV_ERROR,
                EngineErrorPayload {
                    code: "audio-device-failed",
                    message: e.to_string(),
                },
            );
            let _ = app.emit(EV_STATE, "error");
            return Err(e);
        }
    };


    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    // Pick the inference pipeline based on the user's compute_backend
    // preference and the runtime probe in `accelerator::detect()`. The
    // ONNX path takes over when the user pins NPU/GPU and the matching
    // ORT execution provider is actually available; otherwise we stay on
    // whisper.cpp (the more mature pipeline today).
    let provider = pick_provider(cfg.compute_backend.as_deref());
    tracing::info!(
        compute_backend = %cfg.compute_backend.as_deref().unwrap_or("auto"),
        provider,
        "voxnap_start: dispatching to inference pipeline"
    );
    let whisper_handle = match provider {
        "onnx" => {
            let onnx_cfg = whisper_to_onnx(&cfg);
            onnx_engine::spawn(app.clone(), onnx_cfg, consumer, shutdown_rx)
        }
        // "whisper-cpp" / "cpu" / unknown — keep the legacy path.
        _ => whisper::spawn(app.clone(), cfg, consumer, shutdown_rx),
    };

    // Park the cpal stream on a dedicated OS thread; cpal's `Stream` is
    // !Send on some platforms, so we leak it into a thread that just waits
    // for the shutdown signal and drops it.
    let mut shutdown_rx_audio = shutdown_tx.subscribe();
    let audio_handle = std::thread::spawn(move || {
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

    // The whisper task will also emit `running` once it boots, but emitting
    // here gives the UI an instant transition.
    let _ = app.emit(EV_STATE, "running");
    Ok(())
}

#[tauri::command]
pub async fn voxnap_stop(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let mut slot = state.session.lock().await;
    if let Some(session) = slot.take() {
        let _ = session.shutdown.send(true);
        // Detach the std::thread::JoinHandle (cpal stream is dropped inside).
        drop(session.audio_handle);
        let _ = session.whisper_handle.await;
    }
    let _ = app.emit(EV_STATE, "ready");
    Ok(())
}

#[tauri::command]
pub async fn voxnap_dispose(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    // Same body as voxnap_stop; inlined to avoid cloning `State`.
    {
        let mut slot = state.session.lock().await;
        if let Some(session) = slot.take() {
            let _ = session.shutdown.send(true);
            drop(session.audio_handle);
            let _ = session.whisper_handle.await;
        }
    }
    *state.config.lock().await = None;
    let _ = app.emit(EV_STATE, "disposed");
    Ok(())
}


#[tauri::command]
pub fn voxnap_list_devices() -> Result<Vec<AudioDeviceInfo>> {
    audio::list_devices()
}

/// Report the compute accelerators (NPU / GPU / CPU) we can offer on this
/// host given the current cargo features. The UI (`Settings → Model` and
/// the onboarding `Compute` step) renders these so the user can confirm
/// "yes, my NPU is being used" or pin a specific backend.
#[tauri::command]
pub fn voxnap_list_accelerators() -> Vec<AcceleratorInfo> {
    accelerator::detect()
}

// ────────────────────────────────────────────────────────────────────────────
// Model management
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn voxnap_list_models(app: AppHandle) -> Vec<ModelInfo> {
    models::list_models(&app)
}

#[tauri::command]
pub fn voxnap_models_dir(app: AppHandle) -> Result<String> {
    let dir = models::writable_models_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn voxnap_download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    #[allow(non_snake_case)] modelId: String,
) -> Result<()> {
    let registry = state.downloads.clone();
    models::download_model(app, registry, modelId).await
}

#[tauri::command]
pub async fn voxnap_cancel_download(
    state: State<'_, AppState>,
    #[allow(non_snake_case)] modelId: String,
) -> Result<bool> {
    Ok(models::cancel_download(&state.downloads, &modelId).await)
}

#[tauri::command]
pub async fn voxnap_delete_model(
    app: AppHandle,
    #[allow(non_snake_case)] modelId: String,
) -> Result<()> {
    models::delete_model(&app, &modelId).await
}
