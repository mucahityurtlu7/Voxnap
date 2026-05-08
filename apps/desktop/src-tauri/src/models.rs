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
//!
//! ONNX bundle (optional, enables NPU/GPU via ONNX Runtime):
//!   `app_data_dir/models/onnx/<onnxModelId>/`
//!       ├── encoder.onnx
//!       ├── decoder.onnx
//!       ├── decoder_with_past.onnx  (optional)
//!       └── tokenizer.json
//!
//! These are downloaded automatically alongside the ggml model when
//! `voxnap_download_model` is called. The download happens in the
//! background after the ggml file is ready; failures are logged but
//! do not surface as errors to the caller (the CPU fallback still works).

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
    /// `true` when the ONNX accelerator bundle for this model is fully
    /// resident on disk (`encoder.onnx` + `decoder.onnx` + `tokenizer.json`).
    /// The UI's `ModelManagerPanel` uses this to decide whether to show
    /// the "Hızlandırma paketi hazır" rosette next to a model row.
    pub onnx_bundle_ready: bool,
    /// On-disk size (sum of all ONNX files) in bytes when the bundle is
    /// present. `None` when it isn't on disk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onnx_bundle_size_bytes: Option<u64>,
    /// `true` if a Xenova ONNX mirror exists for this model id at all.
    /// Lets the UI greyout the accelerator chip on models we never
    /// publish ONNX for, instead of advertising a missing download.
    pub onnx_bundle_available: bool,
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

/// Probe the ONNX accelerator bundle for `ggml_model_id` on disk.
///
/// Returns `(ready, total_bytes)` where `ready == true` only when every
/// **required** file (`encoder.onnx`, `decoder.onnx`, `tokenizer.json`)
/// is present and non-empty. The optional `decoder_with_past.onnx` is
/// counted toward `total_bytes` when present but does not gate `ready`.
fn locate_onnx_bundle(app: &AppHandle, ggml_model_id: &str) -> (bool, u64) {
    let onnx_id = whisper_id_to_onnx_id(ggml_model_id);
    if xenova_repo_for(&onnx_id).is_none() {
        return (false, 0);
    }
    let mut required_seen = 0usize;
    let mut required_total = 0usize;
    let mut total_bytes: u64 = 0;
    for entry in ONNX_FILES {
        if !entry.optional {
            required_total += 1;
        }
        // Search the same dir matrix as ggml lookups so a `models/`
        // checkout drop-in works without writing into AppData.
        let mut found = false;
        for root in read_search_dirs(app) {
            let p = root.join("onnx").join(&onnx_id).join(entry.local);
            if let Ok(meta) = std::fs::metadata(&p) {
                if meta.is_file() && meta.len() > 0 {
                    total_bytes += meta.len();
                    found = true;
                    break;
                }
            }
        }
        if found && !entry.optional {
            required_seen += 1;
        }
    }
    let ready = required_seen == required_total && required_total > 0;
    (ready, total_bytes)
}

/// Build the static + dynamic info for every known model.
pub fn list_models(app: &AppHandle) -> Vec<ModelInfo> {
    KNOWN_MODELS
        .iter()
        .map(|m| {
            let (onnx_ready, onnx_size) = locate_onnx_bundle(app, m.id);
            let onnx_available = xenova_repo_for(&whisper_id_to_onnx_id(m.id)).is_some();
            match locate_existing(app, m.id) {
                Some((path, size)) => ModelInfo {
                    id: m.id.into(),
                    label: m.label.into(),
                    approx_size_mb: m.approx_size_mb,
                    english_only: m.english_only,
                    downloaded: true,
                    path: Some(path.to_string_lossy().into_owned()),
                    size_bytes: Some(size),
                    onnx_bundle_ready: onnx_ready,
                    onnx_bundle_size_bytes: if onnx_size > 0 { Some(onnx_size) } else { None },
                    onnx_bundle_available: onnx_available,
                },
                None => ModelInfo {
                    id: m.id.into(),
                    label: m.label.into(),
                    approx_size_mb: m.approx_size_mb,
                    english_only: m.english_only,
                    downloaded: false,
                    path: None,
                    size_bytes: None,
                    onnx_bundle_ready: onnx_ready,
                    onnx_bundle_size_bytes: if onnx_size > 0 { Some(onnx_size) } else { None },
                    onnx_bundle_available: onnx_available,
                },
            }
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

            // Kick off the ONNX bundle download in the background so the
            // NPU/GPU acceleration path is ready for the next session.
            // We don't await it — the ggml model is already usable via the
            // CPU whisper.cpp path, and we don't want to block the UI's
            // "Download" button on a second multi-hundred-MB fetch.
            let app_clone = app.clone();
            let mid_clone = model_id.clone();
            tokio::spawn(async move {
                download_onnx_bundle(app_clone, mid_clone).await;
            });

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

// ────────────────────────────────────────────────────────────────────────────
// ONNX bundle download (background, auto-triggered after ggml download)
// ────────────────────────────────────────────────────────────────────────────

/// Translate a whisper.cpp ggml model id (e.g. `base.q5_1`) into the bare
/// Xenova/HuggingFace ONNX export id (e.g. `base`).
///
/// The quantization suffix (`q5_1`, `q5_0`, …) is a whisper.cpp-only
/// artefact — ONNX exports bake their own quantization into the graph.
/// We strip the suffix only when the last dot-segment looks like `qN_M`
/// (exactly 4 bytes: `q`, digit, `_`, digit) so future model ids are
/// not silently mangled.
///
/// This is intentionally kept in sync with `whisper_id_to_onnx_id` in
/// `commands.rs`; both must strip the same suffix or the ONNX probe in
/// `voxnap_start` will disagree with the download path chosen here.
pub fn whisper_id_to_onnx_id(id: &str) -> String {
    if let Some((head, tail)) = id.rsplit_once('.') {
        let b = tail.as_bytes();
        let looks_like_quant = b.len() == 4
            && b[0] == b'q'
            && b[1].is_ascii_digit()
            && b[2] == b'_'
            && b[3].is_ascii_digit();
        if looks_like_quant {
            return head.to_string();
        }
    }
    id.to_string()
}

/// Map a bare ONNX model id to the Xenova HuggingFace repository slug.
/// Returns `None` for ids that are not mirrored by Xenova (in which case
/// the ONNX download is silently skipped).
fn xenova_repo_for(onnx_id: &str) -> Option<&'static str> {
    match onnx_id {
        "tiny"              => Some("whisper-tiny"),
        "tiny.en"           => Some("whisper-tiny.en"),
        "base"              => Some("whisper-base"),
        "base.en"           => Some("whisper-base.en"),
        "small"             => Some("whisper-small"),
        "small.en"          => Some("whisper-small.en"),
        "medium"            => Some("whisper-medium"),
        "medium.en"         => Some("whisper-medium.en"),
        "large-v3"          => Some("whisper-large-v3"),
        "large-v3-turbo"    => Some("whisper-large-v3-turbo"),
        _                   => None,
    }
}

struct OnnxFile {
    local: &'static str,
    remote: &'static str,
    optional: bool,
}

const ONNX_FILES: &[OnnxFile] = &[
    OnnxFile { local: "encoder.onnx",           remote: "onnx/encoder_model.onnx",           optional: false },
    OnnxFile { local: "decoder.onnx",           remote: "onnx/decoder_model.onnx",           optional: false },
    OnnxFile { local: "decoder_with_past.onnx", remote: "onnx/decoder_with_past_model.onnx", optional: true  },
    OnnxFile { local: "tokenizer.json",          remote: "tokenizer.json",                    optional: false },
];

const EV_ONNX_PROGRESS: &str = "voxnap://onnx-bundle-progress";

/// Lifecycle states the UI renders for an ONNX bundle download.
///
/// Mirrors `ModelDownloadState` for the ggml downloader, but adds a
/// dedicated `skipped` state we use when the requested model has no
/// Xenova mirror (so the UI can show "no accelerator pack available"
/// instead of a stale spinner).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnnxProgressEvent<'a> {
    /// The *ggml* model id (`base.q5_1`, `tiny.en.q5_1`, …) — same id
    /// the UI tracks the parent ggml download by, so the two streams
    /// can be joined client-side.
    model_id: &'a str,
    /// Bare ONNX id (`base`, `tiny.en`, …) — handy for diagnostics.
    onnx_id: &'a str,
    /// Logical filename (`encoder.onnx`, `decoder.onnx`, …). `None`
    /// when the event is for the bundle as a whole (e.g. `done`).
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<&'a str>,
    /// Index of the current file (0-based). `done` carries the total.
    file_index: u32,
    /// Total number of files we will try to download for this bundle.
    file_count: u32,
    received_bytes: u64,
    total_bytes: u64,
    percent: f32,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// Mutex-guarded set of ONNX bundle ids currently downloading. We keep
/// this as a *static* state rather than threading it through `AppState`
/// because the ONNX bundle download can be triggered from two paths
/// (the ggml `download_model` post-hook *and* the new manual
/// `voxnap_download_onnx_bundle` command), and both want the same
/// "is anybody else downloading this right now?" guard.
///
/// We keep the storage as a `std::sync::Mutex` (cheap, sync, no extra
/// dependency) because the protected state is just a `HashSet` of
/// strings that we touch for sub-microsecond instants. This avoids
/// pulling in `once_cell` while keeping the API self-contained.
static ONNX_INFLIGHT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn onnx_inflight() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    ONNX_INFLIGHT.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

async fn onnx_inflight_acquire(onnx_id: &str) -> bool {
    let mut g = onnx_inflight().lock().expect("ONNX_INFLIGHT poisoned");
    if g.contains(onnx_id) {
        false
    } else {
        g.insert(onnx_id.to_string());
        true
    }
}

async fn onnx_inflight_release(onnx_id: &str) {
    let mut g = onnx_inflight().lock().expect("ONNX_INFLIGHT poisoned");
    g.remove(onnx_id);
}

fn emit_onnx(
    app: &AppHandle,
    model_id: &str,
    onnx_id: &str,
    file: Option<&str>,
    file_index: u32,
    file_count: u32,
    received_bytes: u64,
    total_bytes: u64,
    percent: f32,
    state: &str,
    message: Option<String>,
) {
    let _ = app.emit(
        EV_ONNX_PROGRESS,
        OnnxProgressEvent {
            model_id,
            onnx_id,
            file,
            file_index,
            file_count,
            received_bytes,
            total_bytes,
            percent: percent.clamp(0.0, 1.0),
            state,
            message,
        },
    );
}

/// Download the ONNX bundle for `ggml_model_id` into
/// `<writable_models_dir>/onnx/<onnx_id>/`.
///
/// This is called automatically in the background after the ggml model
/// finishes downloading, *and* manually via `voxnap_download_onnx_bundle`
/// when the user clicks the "Hızlandırmayı indir" affordance in
/// `ModelManagerPanel`. Errors are logged + emitted as `state: "error"`
/// progress events but never propagate as Rust `Result::Err` — the CPU
/// whisper.cpp fallback always remains available regardless of bundle
/// state.
pub async fn download_onnx_bundle(app: AppHandle, ggml_model_id: String) {
    let onnx_id = whisper_id_to_onnx_id(&ggml_model_id);
    let repo = match xenova_repo_for(&onnx_id) {
        Some(r) => r,
        None => {
            tracing::debug!(
                ggml_model = %ggml_model_id,
                onnx_id = %onnx_id,
                "no Xenova mirror for this model id — skipping ONNX bundle download"
            );
            emit_onnx(
                &app,
                &ggml_model_id,
                &onnx_id,
                None,
                0,
                0,
                0,
                0,
                0.0,
                "skipped",
                Some(format!(
                    "Bu model için Xenova ONNX yansısı yok ({onnx_id}). \
                     Hızlandırma paketi indirilemedi; whisper.cpp CPU yolu \
                     yine de tam çalışır."
                )),
            );
            return;
        }
    };

    if !onnx_inflight_acquire(&onnx_id).await {
        tracing::debug!(
            onnx_id = %onnx_id,
            "onnx_bundle: download already in flight, skipping"
        );
        return;
    }

    let target_dir = match writable_models_dir(&app) {
        Ok(d) => d.join("onnx").join(&onnx_id),
        Err(e) => {
            tracing::error!("onnx_bundle: cannot determine models dir: {e}");
            emit_onnx(
                &app,
                &ggml_model_id,
                &onnx_id,
                None,
                0,
                0,
                0,
                0,
                0.0,
                "error",
                Some(format!("models dir unavailable: {e}")),
            );
            onnx_inflight_release(&onnx_id).await;
            return;
        }
    };

    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        tracing::error!(dir = %target_dir.display(), "onnx_bundle: failed to create dir: {e}");
        emit_onnx(
            &app,
            &ggml_model_id,
            &onnx_id,
            None,
            0,
            0,
            0,
            0,
            0.0,
            "error",
            Some(format!("create dir: {e}")),
        );
        onnx_inflight_release(&onnx_id).await;
        return;
    }

    tracing::info!(
        ggml_model = %ggml_model_id,
        onnx_id = %onnx_id,
        repo,
        dir = %target_dir.display(),
        "onnx_bundle: starting background download"
    );

    let file_count = ONNX_FILES.len() as u32;
    emit_onnx(
        &app,
        &ggml_model_id,
        &onnx_id,
        None,
        0,
        file_count,
        0,
        0,
        0.0,
        "starting",
        None,
    );

    let client = match reqwest::Client::builder()
        .user_agent("voxnap-desktop/0.1")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("onnx_bundle: failed to build http client: {e}");
            emit_onnx(
                &app,
                &ggml_model_id,
                &onnx_id,
                None,
                0,
                file_count,
                0,
                0,
                0.0,
                "error",
                Some(format!("http client: {e}")),
            );
            onnx_inflight_release(&onnx_id).await;
            return;
        }
    };

    let mut had_required_failure = false;

    for (file_index, entry) in ONNX_FILES.iter().enumerate() {
        let dst = target_dir.join(entry.local);
        let file_idx = file_index as u32;

        // Skip files that are already fully downloaded.
        if let Ok(meta) = std::fs::metadata(&dst) {
            if meta.len() > 0 {
                tracing::debug!(file = entry.local, "onnx_bundle: already present, skipping");
                emit_onnx(
                    &app,
                    &ggml_model_id,
                    &onnx_id,
                    Some(entry.local),
                    file_idx,
                    file_count,
                    meta.len(),
                    meta.len(),
                    1.0,
                    "downloading",
                    None,
                );
                continue;
            }
        }

        let url = format!(
            "https://huggingface.co/Xenova/{repo}/resolve/main/{}?download=true",
            entry.remote
        );
        let tmp = dst.with_extension(format!(
            "{}.part",
            dst.extension().and_then(|e| e.to_str()).unwrap_or("bin")
        ));

        tracing::info!(file = entry.local, "onnx_bundle: downloading");
        emit_onnx(
            &app,
            &ggml_model_id,
            &onnx_id,
            Some(entry.local),
            file_idx,
            file_count,
            0,
            0,
            0.0,
            "downloading",
            None,
        );

        match run_onnx_file_download_with_progress(
            &client,
            &url,
            &tmp,
            &dst,
            &app,
            &ggml_model_id,
            &onnx_id,
            entry.local,
            file_idx,
            file_count,
        )
        .await
        {
            Ok(()) => {
                tracing::info!(file = entry.local, "onnx_bundle: done");
            }
            Err(e) if entry.optional => {
                tracing::info!(
                    file = entry.local,
                    "onnx_bundle: optional file unavailable — {e}"
                );
            }
            Err(e) => {
                tracing::error!(file = entry.local, "onnx_bundle: download failed — {e}");
                emit_onnx(
                    &app,
                    &ggml_model_id,
                    &onnx_id,
                    Some(entry.local),
                    file_idx,
                    file_count,
                    0,
                    0,
                    0.0,
                    "error",
                    Some(e),
                );
                had_required_failure = true;
            }
        }
    }

    if had_required_failure {
        tracing::warn!(
            onnx_id = %onnx_id,
            "onnx_bundle: completed with errors on at least one required file"
        );
    } else {
        tracing::info!(onnx_id = %onnx_id, "onnx_bundle: background download complete");
    }

    // Final terminal event so the UI can collapse its progress chip.
    let total_size = locate_onnx_bundle(&app, &ggml_model_id).1;
    emit_onnx(
        &app,
        &ggml_model_id,
        &onnx_id,
        None,
        file_count,
        file_count,
        total_size,
        total_size,
        if had_required_failure { 0.0 } else { 1.0 },
        if had_required_failure { "error" } else { "done" },
        if had_required_failure {
            Some(
                "Hızlandırma paketi tam olarak indirilemedi. CPU yolu çalışmaya devam ediyor; \
                 daha sonra tekrar denemek için yeniden indirebilirsiniz."
                    .into(),
            )
        } else {
            None
        },
    );

    onnx_inflight_release(&onnx_id).await;
}

/// Delete the ONNX bundle for `ggml_model_id`. Best-effort: missing
/// files are silently ignored, but the directory is removed if empty.
pub async fn delete_onnx_bundle(app: &AppHandle, ggml_model_id: &str) -> Result<()> {
    let onnx_id = whisper_id_to_onnx_id(ggml_model_id);
    if xenova_repo_for(&onnx_id).is_none() {
        return Ok(());
    }
    let dir = writable_models_dir(app)?.join("onnx").join(&onnx_id);
    if !dir.exists() {
        return Ok(());
    }
    for entry in ONNX_FILES {
        let p = dir.join(entry.local);
        if p.exists() {
            let _ = tokio::fs::remove_file(&p).await;
        }
    }
    // Drop any leftover .part files too.
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(child)) = rd.next_entry().await {
            let _ = tokio::fs::remove_file(child.path()).await;
        }
    }
    let _ = tokio::fs::remove_dir(&dir).await;

    // Tell the UI the bundle is gone so its rosette flips back.
    emit_onnx(
        app,
        ggml_model_id,
        &onnx_id,
        None,
        0,
        ONNX_FILES.len() as u32,
        0,
        0,
        0.0,
        "deleted",
        None,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_onnx_file_download_with_progress(
    client: &reqwest::Client,
    url: &str,
    tmp: &Path,
    dst: &Path,
    app: &AppHandle,
    ggml_model_id: &str,
    onnx_id: &str,
    file_label: &str,
    file_index: u32,
    file_count: u32,
) -> std::result::Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let total: u64 = resp.content_length().unwrap_or(0);
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();

    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| format!("create {}: {e}", tmp.display()))?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("stream: {e}"))?;
        received += bytes.len() as u64;
        file.write_all(&bytes)
            .await
            .map_err(|e| format!("write: {e}"))?;

        // Throttle progress events to ~5/s.
        let now = Instant::now();
        if now.duration_since(last_emit).as_secs_f64() >= 0.2 {
            last_emit = now;
            let pct = if total > 0 {
                received as f32 / total as f32
            } else {
                0.0
            };
            emit_onnx(
                app,
                ggml_model_id,
                onnx_id,
                Some(file_label),
                file_index,
                file_count,
                received,
                total,
                pct,
                "downloading",
                None,
            );
        }
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(file);

    tokio::fs::rename(tmp, dst)
        .await
        .map_err(|e| format!("rename: {e}"))?;

    // Final per-file progress event so the UI sees 100% before we move on.
    emit_onnx(
        app,
        ggml_model_id,
        onnx_id,
        Some(file_label),
        file_index,
        file_count,
        received,
        total.max(received),
        1.0,
        "downloading",
        None,
    );

    Ok(())
}
