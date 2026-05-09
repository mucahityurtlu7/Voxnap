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

/// Like `pick_provider`, but additionally falls back to `"whisper-cpp"`
/// when `provider == "onnx"` *and* the on-disk ONNX bundle for the
/// requested model is missing.
///
/// This is the dispatcher the recording-start path actually uses. The
/// original `pick_provider` is kept as the no-context routing primitive
/// the unit tests pin, while the production code path always goes
/// through this wrapper so a Windows user who hasn't downloaded the
/// ONNX bundle yet (the very common "auto-routed to DirectML, but no
/// `encoder.onnx` on disk" case) gets a clean whisper.cpp session
/// instead of an "ONNX bundle missing" error.
///
/// Returns `(provider, fall_back_reason)`. When `Some`, the caller is
/// expected to surface a *notice* (not an error) explaining why the
/// session is currently on CPU and that the accelerator pack is being
/// downloaded in the background.
fn pick_provider_with_bundle_check(
    app: &AppHandle,
    cfg: &WhisperConfig,
) -> (&'static str, Option<String>) {
    let provider = pick_provider(cfg.compute_backend.as_deref());
    if provider != "onnx" {
        return (provider, None);
    }
    let onnx_cfg = whisper_to_onnx(cfg);
    match onnx_engine::resolve_model_dir(app, &onnx_cfg) {
        Ok(_) => (provider, None),
        Err(e) => {
            let bucket = cfg.compute_backend.as_deref().unwrap_or("auto");
            // For an explicit "npu" / "gpu" pin we surface the original
            // error so the user knows their override won't take effect
            // until they download the bundle. `auto` callers get the
            // softer "downloading in background" wording, since the
            // background download is auto-triggered below.
            let reason = if bucket == "auto" {
                format!(
                    "Hızlandırma paketi henüz indirilmedi ({onnx_id}). \
                     CPU yolu üzerinden başlatıldı, paket arka planda iniyor — \
                     bir sonraki kayıtta NPU/GPU otomatik kullanılacak.",
                    onnx_id = onnx_cfg.model_id,
                )
            } else {
                format!(
                    "{e}. \"{bucket}\" arka uç henüz hazır değil; CPU yoluna düşüldü. \
                     Hızlandırma paketi arka planda indiriliyor."
                )
            };
            (
                "whisper-cpp",
                Some(reason),
            )
        }
    }
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
/// Delegates to `models::whisper_id_to_onnx_id` — single source of truth
/// for the ggml-id → ONNX-id mapping shared by the dispatcher and the
/// automatic ONNX bundle download triggered by `voxnap_download_model`.
fn whisper_id_to_onnx_id(id: &str) -> String {
    models::whisper_id_to_onnx_id(id)
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
/// Informational, non-error notice channel. Used for things like
/// "you're currently on CPU because the accelerator pack is still
/// downloading" — the session works fine, the user just needs context.
/// The UI's Topbar renders these as a soft info chip rather than the
/// scary red error toast `voxnap://error` triggers.
const EV_NOTICE: &str = "voxnap://notice";

#[derive(Debug, Clone, Serialize)]
struct EngineErrorPayload {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineNoticePayload {
    /// Machine-readable id (`accelerator-fallback`,
    /// `onnx-bundle-downloading`, …) so the UI can choose icons /
    /// dismiss state without parsing the message.
    code: &'static str,
    /// User-facing description (already localised in Turkish on the
    /// Rust side because Voxnap is shipped TR-first today; the UI is
    /// free to translate further).
    message: String,
    /// Severity hint — `"info"` by default, `"warning"` for things the
    /// user might want to act on (e.g. an unexpected fallback).
    #[serde(skip_serializing_if = "Option::is_none")]
    severity: Option<&'static str>,
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
        compute_backend = %config.compute_backend.as_deref().unwrap_or("auto"),
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

    // Eagerly check the ONNX accelerator bundle. The user has just
    // committed to a `compute_backend` (typically by flipping the
    // Settings → Compute picker off "auto"), so this is the right
    // moment to surface "you'll be on CPU until the accelerator pack
    // finishes downloading". We do this *before* the first
    // `voxnap_start` so the soft notice + background download are
    // already in flight by the time the user hits the mic — without
    // this, the very first session would silently run on CPU even
    // though the user explicitly asked for GPU/NPU.
    //
    // The check mirrors the routing the recording path performs in
    // `pick_provider_with_bundle_check`. We deliberately don't error
    // out here: a missing bundle is a soft fallback, not a fatal
    // condition.
    let init_provider = pick_provider(config.compute_backend.as_deref());
    if init_provider == "onnx" {
        let onnx_cfg = whisper_to_onnx(&config);
        if onnx_engine::resolve_model_dir(&app, &onnx_cfg).is_err() {
            let bucket = config.compute_backend.as_deref().unwrap_or("auto");
            let reason = if bucket == "auto" {
                format!(
                    "Hızlandırma paketi henüz indirilmedi ({onnx_id}). \
                     CPU üzerinde başlatıldı, paket arka planda iniyor — \
                     indirme bittiğinde kayıtlar otomatik olarak NPU/GPU'ya geçecek.",
                    onnx_id = onnx_cfg.model_id,
                )
            } else {
                format!(
                    "\"{bucket}\" arka uç için hızlandırma paketi henüz hazır değil. \
                     Voxnap CPU üzerinde başlatıldı; \
                     paket arka planda indiriliyor ve sonraki kayıt {bucket}'da çalışacak."
                )
            };
            let _ = app.emit(
                EV_NOTICE,
                EngineNoticePayload {
                    code: "accelerator-fallback",
                    message: reason,
                    severity: Some("info"),
                },
            );
            // Kick off the bundle download in the background so the
            // user doesn't have to wait through `voxnap_start` for it
            // to start. `download_onnx_bundle` is idempotent — a
            // no-op if it's already on disk or already downloading.
            let app_for_bg = app.clone();
            let model_for_bg = config.model_id.clone();
            tokio::spawn(async move {
                models::download_onnx_bundle(app_for_bg, model_for_bg).await;
            });
        }
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
    // Routing here goes through `pick_provider_with_bundle_check`,
    // which probes `onnx_engine::resolve_model_dir` and falls back to
    // whisper.cpp when the bundle is missing. We *do not* emit a hard
    // error event in that case anymore (the previous behaviour gave
    // users a scary red toast for what is actually a happy-path
    // fallback). Instead, we emit a soft `voxnap://notice` so the UI
    // can show an info chip and trigger the bundle download in the
    // background — the next recording will then auto-promote to NPU.
    let bundle_check = pick_provider_with_bundle_check(&app, &cfg);
    if let Some(reason) = &bundle_check.1 {
        provider = bundle_check.0;
        tracing::info!(
            reason = %reason,
            "voxnap_start: accelerator bundle missing, falling back to whisper.cpp"
        );
        let _ = app.emit(
            EV_NOTICE,
            EngineNoticePayload {
                code: "accelerator-fallback",
                message: reason.clone(),
                severity: Some("info"),
            },
        );
        // Kick off the ONNX bundle download in the background so the
        // *next* session can promote to NPU/GPU without the user doing
        // anything. The function is idempotent — a no-op when the
        // bundle is already on disk or already downloading.
        let app_for_bg = app.clone();
        let model_for_bg = cfg.model_id.clone();
        tokio::spawn(async move {
            models::download_onnx_bundle(app_for_bg, model_for_bg).await;
        });
    } else {
        // Even if the dispatcher kept `provider` unchanged, honour the
        // bundle-aware decision (e.g. when a user pinned `cpu` we
        // already returned early from the wrapper).
        provider = bundle_check.0;
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

/// Manually trigger an ONNX accelerator-bundle download. The UI exposes
/// this from `ModelManagerPanel` ("Hızlandırmayı indir" button) so the
/// user can pre-warm the NPU/GPU path without waiting for it to be
/// auto-triggered on the first recording. The function is fire-and-
/// forget — progress lands on the `voxnap://onnx-bundle-progress`
/// channel and the on-disk state is reflected by the next
/// `voxnap_list_models` call.
#[tauri::command]
pub async fn voxnap_download_onnx_bundle(
    app: AppHandle,
    #[allow(non_snake_case)] modelId: String,
) -> Result<()> {
    // We deliberately don't await the download here — the UI just wants
    // to know "yes, I started it"; the bundle can be hundreds of MB.
    tokio::spawn(async move {
        models::download_onnx_bundle(app, modelId).await;
    });
    Ok(())
}

/// Delete the ONNX accelerator bundle for `modelId`. Best-effort: if
/// the bundle isn't on disk we still return Ok so the UI can treat it
/// as idempotent.
#[tauri::command]
pub async fn voxnap_delete_onnx_bundle(
    app: AppHandle,
    #[allow(non_snake_case)] modelId: String,
) -> Result<()> {
    models::delete_onnx_bundle(&app, &modelId).await
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


