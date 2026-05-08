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

use crate::accelerator::{self, AcceleratorInfo, DiagnosticReport};
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
/// `"auto"` semantics:
///   • If a real NPU is `available = true`, we route there (NPU > GPU > CPU).
///   • If only a GPU is available we route there.
///   • Otherwise we stay on the whisper.cpp CPU path.
///
/// The previous version hard-pinned `"auto"` to whisper.cpp regardless of
/// what the runtime probe reported, which meant that even on a Copilot+
/// laptop with a working DirectML EP the model would still run on the
/// CPU. With the dispatcher being driven by `detect()` we now light up
/// the NPU/GPU automatically — the user only has to flip the picker
/// off `auto` to *override* the choice, not to opt in.
fn pick_provider(compute_backend: Option<&str>) -> &'static str {
    let want = compute_backend.unwrap_or("auto");

    if want == "cpu" {
        // The user explicitly pinned CPU; respect that. whisper.cpp is
        // the more mature pure-CPU pipeline today.
        return "whisper-cpp";
    }

    if want == "auto" {
        // Walk the detection result in priority order (NPU first, then
        // GPU). The first row that's `available = true` wins, and we
        // hand the session to whichever pipeline that row declares.
        let rows = accelerator::detect();
        if let Some(npu) = rows.iter().find(|r| r.id == "npu" && r.available) {
            tracing::info!(
                backend = npu.backend,
                provider = npu.provider,
                label = %npu.label,
                "auto-routing to NPU"
            );
            return npu.provider;
        }
        if let Some(gpu) = rows.iter().find(|r| r.id == "gpu" && r.available) {
            tracing::info!(
                backend = gpu.backend,
                provider = gpu.provider,
                label = %gpu.label,
                "auto-routing to GPU"
            );
            return gpu.provider;
        }
        // No accelerator is usable — whisper.cpp's CPU path is the
        // legacy / best-tested fallback.
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
    tracing::warn!(
        bucket = want,
        "no available accelerator for requested bucket — falling back to whisper.cpp/CPU"
    );
    "whisper-cpp"
}

/// Translate a whisper.cpp ggml model id (the JS-side `WhisperModelId`)
/// into the bare id HuggingFace's optimum ONNX exports use.
///
/// The two pipelines speak slightly different model-id dialects:
///
/// | JS / whisper.cpp        | ONNX export (Xenova)   |
/// | ----------------------- | ---------------------- |
/// | `base.q5_1`             | `base`                 |
/// | `base.en.q5_1`          | `base.en`              |
/// | `medium.q5_0`           | `medium`               |
/// | `large-v3-turbo.q5_0`   | `large-v3-turbo`       |
///
/// The trailing `qN_M` quantization tag is a whisper.cpp-only artefact —
/// ONNX exports use a different (export-time) quantization scheme baked
/// into the graph itself. Without this remapping, picking
/// `compute_backend = "npu"` (or any auto-routed NPU/GPU build) would
/// fail with `ONNX bundle for model id 'base.q5_1' (need encoder.onnx)`
/// because `onnx/base.q5_1/encoder.onnx` does not exist on disk after
/// `pnpm fetch:onnx-model`.
///
/// We strip the suffix conservatively — only when the *last* dot-segment
/// matches the exact `q\d_\d` shape — so any future export that decides
/// to ship its own suffixes is not silently mangled.
fn whisper_id_to_onnx_id(id: &str) -> String {
    if let Some((head, tail)) = id.rsplit_once('.') {
        let bytes = tail.as_bytes();
        let looks_like_quant = bytes.len() == 4
            && bytes[0] == b'q'
            && bytes[1].is_ascii_digit()
            && bytes[2] == b'_'
            && bytes[3].is_ascii_digit();
        if looks_like_quant {
            return head.to_string();
        }
    }
    id.to_string()
}

/// Convert the JS-side WhisperConfig into the OnnxConfig the parallel
/// pipeline expects. The two configs were intentionally given identical
/// JSON shapes so this is mostly field-by-field — except for `model_id`,
/// which has to be remapped from whisper.cpp's ggml dialect to the bare
/// ids used by HuggingFace's ONNX exports (see
/// [`whisper_id_to_onnx_id`]).
fn whisper_to_onnx(cfg: &WhisperConfig) -> OnnxConfig {
    OnnxConfig {
        model_id: whisper_id_to_onnx_id(&cfg.model_id),
        language: cfg.language.clone(),
        model_dir: cfg.model_dir.clone(),
        translate: cfg.translate,
        threads: cfg.threads,
        compute_backend: cfg.compute_backend.clone(),
        // Beam search and timestamps are not yet exposed on
        // `WhisperConfig` / the JS side. Leaving them at their defaults
        // (greedy decode, no timestamp tokens) keeps the dispatched
        // ONNX session functionally identical to whisper.cpp's current
        // single-pass output, and lets the new code paths in
        // `onnx_engine.rs` light up later via a config-only change.
        beam_size: None,
        timestamps: false,
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
    let mut provider = pick_provider(cfg.compute_backend.as_deref());
    tracing::info!(
        compute_backend = %cfg.compute_backend.as_deref().unwrap_or("auto"),
        provider,
        "voxnap_start: dispatching to inference pipeline"
    );

    // The ONNX pipeline needs a separately-downloaded bundle
    // (`encoder.onnx` & friends) which lives in a different on-disk
    // layout than the ggml whisper.cpp models. If the user only
    // downloaded the ggml model — the common case for first-time
    // installs that picked `auto` and got auto-routed to NPU/GPU —
    // we'd otherwise emit `ONNX bundle for model id 'base[.q5_1]'
    // (need encoder.onnx)` and never start a session at all.
    //
    // Probe `onnx_engine::resolve_model_dir` here and *gracefully*
    // fall back to whisper.cpp when the bundle is missing. We log
    // the fallback so the UI status badge ("running on NPU") and the
    // logs stay in sync — the user still gets a working transcript,
    // just on the CPU path until they run `pnpm fetch:onnx-model`.
    if provider == "onnx" {
        let onnx_cfg = whisper_to_onnx(&cfg);
        if let Err(e) = onnx_engine::resolve_model_dir(&app, &onnx_cfg) {
            tracing::warn!(
                error = %e,
                onnx_model_id = %onnx_cfg.model_id,
                whisper_model_id = %cfg.model_id,
                "ONNX bundle missing — falling back to whisper.cpp \
                 (run `pnpm fetch:onnx-model` to enable the accelerator path)"
            );
            let _ = app.emit(
                EV_ERROR,
                EngineErrorPayload {
                    code: "onnx-bundle-missing",
                    message: format!(
                        "{e} — falling back to whisper.cpp on the CPU. \
                         Run `pnpm fetch:onnx-model` to enable the accelerator path."
                    ),
                },
            );
            provider = "whisper-cpp";
        }
    }

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

/// Detailed accelerator diagnostic. The UI's "Diagnose NPU" button calls
/// this and renders one line per probe (compile-features, EP probes, PnP
/// scan results) so the user can see *why* their NPU is or isn't lighting
/// up — not just an opaque "Unavailable" badge.
///
/// Cheap to call (a few hundred ms tops on Windows because of the
/// PowerShell launch); the UI runs it lazily when the user opens the
/// modal, not on every render.
#[tauri::command]
pub fn voxnap_diagnose_accelerators() -> DiagnosticReport {
    accelerator::diagnose()
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

// ────────────────────────────────────────────────────────────────────────────
// Smoke tests
// ────────────────────────────────────────────────────────────────────────────
//
// Phase 3 covers the dispatcher invariants the UI relies on. We don't run
// real inference here — that needs a model bundle + a microphone — but we
// can lock in the routing rules so a future refactor can't silently change
// which pipeline serves which `compute_backend` bucket.
#[cfg(test)]
mod tests {
    use super::*;

    /// `cpu` always stays on whisper.cpp, regardless of what hardware is
    /// available. That's the contract the UI relies on — picking CPU is
    /// a deliberate "don't use my accelerator" override.
    #[test]
    fn cpu_pick_is_always_whisper_cpp() {
        assert_eq!(pick_provider(Some("cpu")), "whisper-cpp");
    }

    /// `auto` (and `None`) routes to whichever pipeline `accelerator::detect()`
    /// reports as the best available row. On a CI runner with no
    /// accelerator features compiled in that means whisper.cpp; on a
    /// build with DirectML/CoreML wired in it should pick the ONNX path.
    /// We assert *consistency* with `detect()` rather than a fixed value
    /// so the test passes across the full build matrix.
    #[test]
    fn auto_picks_first_available_accelerator() {
        let want_provider = {
            let rows = accelerator::detect();
            if let Some(npu) = rows.iter().find(|r| r.id == "npu" && r.available) {
                npu.provider
            } else if let Some(gpu) = rows.iter().find(|r| r.id == "gpu" && r.available) {
                gpu.provider
            } else {
                "whisper-cpp"
            }
        };
        assert_eq!(pick_provider(Some("auto")), want_provider);
        assert_eq!(pick_provider(None), want_provider);
    }

    /// Picking a bucket with no matching available accelerator should
    /// fall back to whisper.cpp — the same observed behaviour as before
    /// the dispatcher existed. We verify that by passing a bucket that
    /// no platform currently exposes (`"tpu"`).
    #[test]
    fn unknown_bucket_falls_back_to_whisper_cpp() {
        assert_eq!(pick_provider(Some("tpu")), "whisper-cpp");
    }

    /// Every available row in `accelerator::detect()` must round-trip
    /// through `pick_provider`. If the user pins one of those buckets,
    /// the dispatcher must hand the session off to the same `provider`
    /// the row claims; otherwise the UI badge ("running on NPU") would
    /// lie to the user.
    #[test]
    fn dispatcher_honours_detect_provider_for_available_rows() {
        for row in accelerator::detect() {
            if !row.available || row.id == "cpu" {
                continue;
            }
            // We can't simply call `pick_provider(Some(row.id))` and
            // expect `row.provider`, because `detect()` may report
            // multiple rows for the same bucket (e.g. CUDA + DirectML
            // both under `"gpu"`). The contract is *first available
            // wins*, which is exactly what the dispatcher implements.
            let chosen = pick_provider(Some(row.id));
            let first = accelerator::detect()
                .into_iter()
                .find(|r| r.id == row.id && r.available)
                .expect("we just iterated past one");
            assert_eq!(
                chosen, first.provider,
                "dispatcher disagreed with detect() for bucket {}",
                row.id,
            );
        }
    }

    /// `whisper_to_onnx` must not lose any field that the JS side sets,
    /// otherwise toggling `compute_backend = "npu"` with `translate =
    /// true` would silently drop the translation flag at the dispatcher.
    #[test]
    fn whisper_to_onnx_preserves_user_fields() {
        let cfg = WhisperConfig {
            model_id: "base.en".into(),
            language: "en".into(),
            model_dir: Some("/tmp/models".into()),
            translate: true,
            threads: Some(4),
            compute_backend: Some("npu".into()),
            ..Default::default()
        };
        let onnx = whisper_to_onnx(&cfg);
        assert_eq!(onnx.model_id, "base.en");
        assert_eq!(onnx.language, "en");
        assert_eq!(onnx.model_dir.as_deref(), Some("/tmp/models"));
        assert!(onnx.translate);
        assert_eq!(onnx.threads, Some(4));
        assert_eq!(onnx.compute_backend.as_deref(), Some("npu"));
        // Phase 2C-only fields stay defaulted (not yet wired from JS).
        assert_eq!(onnx.beam_size, None);
        assert!(!onnx.timestamps);
    }

    /// The whisper.cpp model ids the JS side ships (`base.q5_1`,
    /// `medium.q5_0`, `large-v3-turbo.q5_0`, …) carry a quantization
    /// suffix that doesn't exist in HuggingFace's ONNX exports. The
    /// dispatcher must strip it before handing the id to the ONNX
    /// pipeline; otherwise `onnx_engine::resolve_model_dir` would look
    /// up `onnx/base.q5_1/encoder.onnx` (which never exists) and fail
    /// the whole recording.
    #[test]
    fn whisper_id_to_onnx_id_strips_quantization_suffix() {
        assert_eq!(whisper_id_to_onnx_id("base.q5_1"), "base");
        assert_eq!(whisper_id_to_onnx_id("base.en.q5_1"), "base.en");
        assert_eq!(whisper_id_to_onnx_id("tiny.q5_1"), "tiny");
        assert_eq!(whisper_id_to_onnx_id("tiny.en.q5_1"), "tiny.en");
        assert_eq!(whisper_id_to_onnx_id("small.q5_1"), "small");
        assert_eq!(whisper_id_to_onnx_id("small.en.q5_1"), "small.en");
        assert_eq!(whisper_id_to_onnx_id("medium.q5_0"), "medium");
        assert_eq!(whisper_id_to_onnx_id("medium.en.q5_0"), "medium.en");
        assert_eq!(whisper_id_to_onnx_id("large-v3.q5_0"), "large-v3");
        assert_eq!(
            whisper_id_to_onnx_id("large-v3-turbo.q5_0"),
            "large-v3-turbo"
        );

        // Bare ids (already in ONNX-export shape) are passed through.
        assert_eq!(whisper_id_to_onnx_id("base"), "base");
        assert_eq!(whisper_id_to_onnx_id("base.en"), "base.en");
        assert_eq!(whisper_id_to_onnx_id("large-v3"), "large-v3");

        // Anything that doesn't end in a 4-char `qN_M` token must not
        // be touched — protects future model ids we haven't seen yet.
        assert_eq!(whisper_id_to_onnx_id("base.fp16"), "base.fp16");
        assert_eq!(whisper_id_to_onnx_id("base.q12_3"), "base.q12_3");
    }

    /// `whisper_to_onnx` must apply the id remapping above so that the
    /// `OnnxConfig` it produces actually points at a directory that
    /// exists on disk after `pnpm fetch:onnx-model`.
    #[test]
    fn whisper_to_onnx_strips_ggml_quant_suffix() {
        let cfg = WhisperConfig {
            model_id: "base.q5_1".into(),
            language: "auto".into(),
            ..Default::default()
        };
        assert_eq!(whisper_to_onnx(&cfg).model_id, "base");

        let cfg = WhisperConfig {
            model_id: "medium.en.q5_0".into(),
            language: "auto".into(),
            ..Default::default()
        };
        assert_eq!(whisper_to_onnx(&cfg).model_id, "medium.en");
    }
}


