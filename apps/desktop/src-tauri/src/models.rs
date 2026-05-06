//! Whisper model management.
//!
//! Owns:
//!   • the well-known list of ggml models we ship metadata for
//!   • the on-disk model directory (`<app-data>/models`)
//!   • streaming downloads from huggingface.co with cancellation + progress
//!   • delete / list operations the UI calls from Settings + Onboarding
//!
//! IPC contract (matches `packages/core/src/models/IModelManager.ts`):
//!
//!   commands:
//!     voxnap_list_models                         → Vec<ModelInfo>
//!     voxnap_download_model { modelId }          → ()
//!     voxnap_cancel_download { modelId }         → ()
//!     voxnap_delete_model   { modelId }          → ()
//!     voxnap_models_dir                          → String (absolute path)
//!
//!   events (per-download progress):
//!     voxnap://model-download-progress
//!       { modelId, receivedBytes, totalBytes, percent, speedBps,
//!         state: "starting"|"downloading"|"done"|"error"|"cancelled",
//!         message? }
//!
//! Storage layout
//! --------------
//! Files live under `app_data_dir/models/ggml-<modelId>.bin`. We deliberately
//! keep the same naming convention as `scripts/fetch-model.mjs` so model
//! files dropped via the CLI are picked up automatically.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Mutex};

use crate::error::{Error, Result};

/// Logical id strings — must match `WhisperModelId` in `packages/core`.
///
/// Only quantizations that actually exist on
/// `https://huggingface.co/ggerganov/whisper.cpp/tree/main` are listed.
/// Notably, `medium` and `large*` only have `q5_0` quants (no `q5_1`).
pub const KNOWN_MODELS: &[ModelMeta] = &[
    ModelMeta { id: "tiny.q5_1",            label: "Tiny (multilingual)",          approx_size_mb: 31,   english_only: false },
    ModelMeta { id: "tiny.en.q5_1",         label: "Tiny (English)",               approx_size_mb: 31,   english_only: true  },
    ModelMeta { id: "base.q5_1",            label: "Base (multilingual)",          approx_size_mb: 57,   english_only: false },
    ModelMeta { id: "base.en.q5_1",         label: "Base (English)",               approx_size_mb: 57,   english_only: true  },
    ModelMeta { id: "small.q5_1",           label: "Small (multilingual)",         approx_size_mb: 181,  english_only: false },
    ModelMeta { id: "small.en.q5_1",        label: "Small (English)",              approx_size_mb: 181,  english_only: true  },
    ModelMeta { id: "medium.q5_0",          label: "Medium (multilingual)",        approx_size_mb: 539,  english_only: false },
    ModelMeta { id: "medium.en.q5_0",       label: "Medium (English)",             approx_size_mb: 539,  english_only: true  },
    ModelMeta { id: "large-v3.q5_0",        label: "Large v3 (multilingual)",      approx_size_mb: 1080, english_only: false },
    ModelMeta { id: "large-v3-turbo.q5_0",  label: "Large v3 Turbo (multilingual)", approx_size_mb: 547, english_only: false },
];


#[derive(Debug, Clone, Copy)]
pub struct ModelMeta {
    pub id: &'static str,
    pub label: &'static str,
    pub approx_size_mb: u32,
    pub english_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub approx_size_mb: u32,
    pub english_only: bool,
    pub downloaded: bool,
    /// Absolute path to the on-disk file when `downloaded == true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Actual on-disk size in bytes, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Map a model id to the on-disk file name (matches `scripts/fetch-model.mjs`).
fn file_name_for(model_id: &str) -> String {
    format!("ggml-{model_id}.bin")
}

/// Hugging Face uses a dash instead of a dot **only** before the quant
/// suffix. The `.en` infix on English-only models is preserved as-is.
///
/// Examples:
///   `base.q5_1`        → `ggml-base-q5_1.bin`
///   `tiny.en.q5_1`     → `ggml-tiny.en-q5_1.bin`
///   `medium.q5_0`      → `ggml-medium-q5_0.bin`
///   `large-v3.q5_0`    → `ggml-large-v3-q5_0.bin`
///
/// Naively replacing every `.` with `-` (the previous behaviour) produced
/// 404s for English-only quants because the canonical path on HF still
/// uses `.en`.
fn hf_file_name_for(model_id: &str) -> String {
    let hf_id = match model_id.rsplit_once('.') {
        // Convert only the last `.` (the one separating the quant suffix).
        Some((prefix, suffix)) => format!("{prefix}-{suffix}"),
        None => model_id.to_string(),
    };
    format!("ggml-{hf_id}.bin")
}

fn hf_url_for(model_id: &str) -> String {
    let hf_name = hf_file_name_for(model_id);
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{hf_name}?download=true"
    )
}

#[cfg(test)]
mod url_tests {
    use super::*;

    #[test]
    fn hf_filename_handles_quant_only() {
        assert_eq!(hf_file_name_for("base.q5_1"), "ggml-base-q5_1.bin");
        assert_eq!(hf_file_name_for("medium.q5_0"), "ggml-medium-q5_0.bin");
    }

    #[test]
    fn hf_filename_preserves_english_infix() {
        assert_eq!(hf_file_name_for("tiny.en.q5_1"), "ggml-tiny.en-q5_1.bin");
        assert_eq!(hf_file_name_for("medium.en.q5_0"), "ggml-medium.en-q5_0.bin");
    }

    #[test]
    fn hf_filename_handles_dashes_in_id() {
        assert_eq!(hf_file_name_for("large-v3.q5_0"), "ggml-large-v3-q5_0.bin");
        assert_eq!(
            hf_file_name_for("large-v3-turbo.q5_0"),
            "ggml-large-v3-turbo-q5_0.bin"
        );
    }
}


/// Writable directory: `<app-data>/models`. Created on demand.
pub fn writable_models_dir(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Other(format!("app_data_dir unavailable: {e}")))?;
    let dir = base.join("models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// All directories we will check when deciding whether a model is already
/// downloaded. Kept in sync with `whisper::resolve_model_path`.
fn read_search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().app_data_dir() {
        dirs.push(p.join("models"));
    }
    if let Ok(p) = app.path().resource_dir() {
        dirs.push(p.join("models"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            let mut cur: Option<&Path> = Some(d);
            for _ in 0..8 {
                let Some(dd) = cur else { break };
                dirs.push(dd.join("models"));
                cur = dd.parent();
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur: Option<&Path> = Some(cwd.as_path());
        for _ in 0..8 {
            let Some(dd) = cur else { break };
            dirs.push(dd.join("models"));
            cur = dd.parent();
        }
    }
    dirs
}

fn locate_existing(app: &AppHandle, model_id: &str) -> Option<(PathBuf, u64)> {
    let file = file_name_for(model_id);
    for dir in read_search_dirs(app) {
        let p = dir.join(&file);
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.is_file() && meta.len() > 0 {
                return Some((p, meta.len()));
            }
        }
    }
    None
}

/// Build the static + dynamic info for every known model.
pub fn list_models(app: &AppHandle) -> Vec<ModelInfo> {
    KNOWN_MODELS
        .iter()
        .map(|m| match locate_existing(app, m.id) {
            Some((path, size)) => ModelInfo {
                id: m.id.into(),
                label: m.label.into(),
                approx_size_mb: m.approx_size_mb,
                english_only: m.english_only,
                downloaded: true,
                path: Some(path.to_string_lossy().into_owned()),
                size_bytes: Some(size),
            },
            None => ModelInfo {
                id: m.id.into(),
                label: m.label.into(),
                approx_size_mb: m.approx_size_mb,
                english_only: m.english_only,
                downloaded: false,
                path: None,
                size_bytes: None,
            },
        })
        .collect()
}

// ────────────────────────────────────────────────────────────────────────────
// Downloads
// ────────────────────────────────────────────────────────────────────────────

const EV_PROGRESS: &str = "voxnap://model-download-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    model_id: &'a str,
    received_bytes: u64,
    total_bytes: u64,
    /// 0..1
    percent: f32,
    /// Bytes per second (instantaneous-ish, EMA over the last few ticks).
    #[serde(skip_serializing_if = "Option::is_none")]
    speed_bps: Option<f64>,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Default)]
pub struct DownloadRegistry {
    /// `Some(sender)` while a download is in progress; the sender broadcasts
    /// `true` to ask the worker to abort.
    inner: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl DownloadRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn is_active(&self, model_id: &str) -> bool {
        self.inner.lock().await.contains_key(model_id)
    }

    async fn register(&self, model_id: &str, tx: watch::Sender<bool>) {
        self.inner.lock().await.insert(model_id.to_string(), tx);
    }

    async fn unregister(&self, model_id: &str) {
        self.inner.lock().await.remove(model_id);
    }

    async fn cancel(&self, model_id: &str) -> bool {
        if let Some(tx) = self.inner.lock().await.get(model_id) {
            let _ = tx.send(true);
            true
        } else {
            false
        }
    }
}

/// Stream a model from huggingface, write atomically to disk, emit progress.
pub async fn download_model(
    app: AppHandle,
    registry: Arc<DownloadRegistry>,
    model_id: String,
) -> Result<()> {
    // Reject unknown ids early so we don't hammer HF with nonsense paths.
    if !KNOWN_MODELS.iter().any(|m| m.id == model_id) {
        return Err(Error::Other(format!("unknown model id: {model_id}")));
    }

    if registry.is_active(&model_id).await {
        return Err(Error::Other("download already in progress".into()));
    }

    // If the file already exists locally we treat the call as a no-op and
    // surface a `done` event so the UI can flip its state.
    if let Some((path, size)) = locate_existing(&app, &model_id) {
        let _ = app.emit(
            EV_PROGRESS,
            ProgressEvent {
                model_id: &model_id,
                received_bytes: size,
                total_bytes: size,
                percent: 1.0,
                speed_bps: None,
                state: "done",
                message: None,
            },
        );
        tracing::info!(model = %model_id, path = %path.display(), "model already present");
        return Ok(());
    }

    let dir = writable_models_dir(&app)?;
    let final_path = dir.join(file_name_for(&model_id));
    let tmp_path = dir.join(format!("{}.part", file_name_for(&model_id)));

    let (cancel_tx, mut cancel_rx) = watch::channel::<bool>(false);
    registry.register(&model_id, cancel_tx).await;

    // Initial "starting" event so the UI can flip to a determinate spinner.
    let _ = app.emit(
        EV_PROGRESS,
        ProgressEvent {
            model_id: &model_id,
            received_bytes: 0,
            total_bytes: 0,
            percent: 0.0,
            speed_bps: None,
            state: "starting",
            message: None,
        },
    );

    let outcome = run_download(
        &app,
        &model_id,
        &tmp_path,
        &final_path,
        &mut cancel_rx,
    )
    .await;

    // Always unregister so the same model can be re-tried on failure.
    registry.unregister(&model_id).await;

    match outcome {
        Ok(()) => {
            let total = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                EV_PROGRESS,
                ProgressEvent {
                    model_id: &model_id,
                    received_bytes: total,
                    total_bytes: total,
                    percent: 1.0,
                    speed_bps: None,
                    state: "done",
                    message: None,
                },
            );
            tracing::info!(model = %model_id, path = %final_path.display(), "model downloaded");
            Ok(())
        }
        Err(DownloadOutcome::Cancelled) => {
            // Best-effort cleanup of the .part file.
            let _ = tokio::fs::remove_file(&tmp_path).await;
            let _ = app.emit(
                EV_PROGRESS,
                ProgressEvent {
                    model_id: &model_id,
                    received_bytes: 0,
                    total_bytes: 0,
                    percent: 0.0,
                    speed_bps: None,
                    state: "cancelled",
                    message: None,
                },
            );
            tracing::info!(model = %model_id, "model download cancelled");
            Ok(())
        }
        Err(DownloadOutcome::Failed(msg)) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            let _ = app.emit(
                EV_PROGRESS,
                ProgressEvent {
                    model_id: &model_id,
                    received_bytes: 0,
                    total_bytes: 0,
                    percent: 0.0,
                    speed_bps: None,
                    state: "error",
                    message: Some(msg.clone()),
                },
            );
            tracing::error!(model = %model_id, "model download failed: {msg}");
            Err(Error::Other(msg))
        }
    }
}

enum DownloadOutcome {
    Cancelled,
    Failed(String),
}

async fn run_download(
    app: &AppHandle,
    model_id: &str,
    tmp_path: &Path,
    final_path: &Path,
    cancel_rx: &mut watch::Receiver<bool>,
) -> std::result::Result<(), DownloadOutcome> {
    let url = hf_url_for(model_id);
    tracing::info!(model = %model_id, url, "downloading");

    let client = reqwest::Client::builder()
        .user_agent("voxnap-desktop/0.1")
        .build()
        .map_err(|e| DownloadOutcome::Failed(format!("http client: {e}")))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| DownloadOutcome::Failed(format!("request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(DownloadOutcome::Failed(format!(
            "HTTP {} for {url}",
            resp.status().as_u16()
        )));
    }

    let total: u64 = resp.content_length().unwrap_or(0);
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut last_emit_bytes: u64 = 0;
    let mut speed_bps: f64 = 0.0;

    let mut file = tokio::fs::File::create(tmp_path)
        .await
        .map_err(|e| DownloadOutcome::Failed(format!("create {}: {e}", tmp_path.display())))?;

    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            // Cancellation arm.
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    return Err(DownloadOutcome::Cancelled);
                }
            }
            // Download arm.
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        if let Err(e) = file.write_all(&bytes).await {
                            return Err(DownloadOutcome::Failed(format!("write: {e}")));
                        }
                        received += bytes.len() as u64;

                        // Throttle the JS event stream to ~5 events / sec to
                        // keep the IPC bridge from getting flooded on fast
                        // connections.
                        let now = Instant::now();
                        let dt = now.duration_since(last_emit).as_secs_f64();
                        if dt >= 0.2 {
                            let inst_bps = if dt > 0.0 {
                                ((received - last_emit_bytes) as f64) / dt
                            } else {
                                0.0
                            };
                            // Light EMA so the readout doesn't flicker.
                            speed_bps = if speed_bps == 0.0 { inst_bps } else { speed_bps * 0.7 + inst_bps * 0.3 };
                            last_emit = now;
                            last_emit_bytes = received;
                            let percent = if total > 0 {
                                (received as f32) / (total as f32)
                            } else {
                                0.0
                            };
                            let _ = app.emit(
                                EV_PROGRESS,
                                ProgressEvent {
                                    model_id,
                                    received_bytes: received,
                                    total_bytes: total,
                                    percent: percent.clamp(0.0, 1.0),
                                    speed_bps: Some(speed_bps),
                                    state: "downloading",
                                    message: None,
                                },
                            );
                        }
                    }
                    Some(Err(e)) => {
                        return Err(DownloadOutcome::Failed(format!("stream: {e}")));
                    }
                    None => {
                        // EOF.
                        break;
                    }
                }
            }
        }
    }

    if let Err(e) = file.flush().await {
        return Err(DownloadOutcome::Failed(format!("flush: {e}")));
    }
    drop(file);

    // Atomic rename .part → final.
    if let Err(e) = tokio::fs::rename(tmp_path, final_path).await {
        return Err(DownloadOutcome::Failed(format!(
            "rename {} → {}: {e}",
            tmp_path.display(),
            final_path.display()
        )));
    }

    Ok(())
}

/// Cancel an in-flight download. Returns true if a download was found.
pub async fn cancel_download(registry: &DownloadRegistry, model_id: &str) -> bool {
    registry.cancel(model_id).await
}

/// Delete a downloaded model file (only inside the writable models dir).
pub async fn delete_model(app: &AppHandle, model_id: &str) -> Result<()> {
    if !KNOWN_MODELS.iter().any(|m| m.id == model_id) {
        return Err(Error::Other(format!("unknown model id: {model_id}")));
    }
    let dir = writable_models_dir(app)?;
    let path = dir.join(file_name_for(model_id));
    if tokio::fs::metadata(&path).await.is_ok() {
        tokio::fs::remove_file(&path).await?;
    }
    Ok(())
}
