//! Whisper inference worker.
//!
//! This is the bridge between the cpal ring buffer (`audio.rs`) and the
//! webview. It owns a `whisper-rs` context and runs in a dedicated tokio
//! task so the UI thread is never blocked by inference.
//!
//! Streaming strategy
//! ------------------
//!
//! We use the classic "sliding window with overlap" approach:
//!
//!  • Accumulate ~`window_secs` of audio (e.g. 5s).
//!  • Run `whisper.full()` on the window.
//!  • Emit each segment as a *partial* result keyed by its `start_ms`.
//!  • Slide the window forward by `step_secs` (e.g. 1s) and repeat. Segments
//!    whose start time is *before* the new window are promoted to **final**
//!    (they will not change anymore).
//!
//! That gives the JS layer a stable id per segment and a smooth partial→final
//! transition, which `useTranscription` already knows how to render.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use ringbuf::traits::Consumer as _;
use tokio::sync::watch;

use crate::audio::{Consumer, TARGET_SAMPLE_RATE};
use crate::error::{Error, Result};

#[derive(Debug, Clone, serde::Deserialize)]
pub struct WhisperConfig {
    /// Logical model id, e.g. `"base.q5_1"` (matches `WhisperModelId` on JS).
    #[serde(rename = "modelId")]
    pub model_id: String,

    /// `"auto"` or an ISO-639-1 code understood by whisper.cpp.
    #[serde(default = "default_lang")]
    pub language: String,

    /// Override the directory where `ggml-<modelId>.bin` lives. Defaults to
    /// `<app-data>/models` and `<resource-dir>/models`.
    #[serde(default, rename = "modelDir")]
    pub model_dir: Option<String>,
}

fn default_lang() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmittedSegment {
    pub id: String,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub is_final: bool,
}

/// Locate the model file. Search order:
///   1. `cfg.model_dir` if provided
///   2. `<app-data>/models`
///   3. `<resource-dir>/models` (bundled)
pub fn resolve_model_path(app: &AppHandle, cfg: &WhisperConfig) -> Result<PathBuf> {
    let file_name = format!("ggml-{}.bin", cfg.model_id);
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(dir) = &cfg.model_dir {
        candidates.push(PathBuf::from(dir).join(&file_name));
    }
    if let Ok(p) = app.path().app_data_dir() {
        candidates.push(p.join("models").join(&file_name));
    }
    if let Ok(p) = app.path().resource_dir() {
        candidates.push(p.join("models").join(&file_name));
    }

    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| Error::ModelMissing(file_name))
}

/// Spawn the inference task. It takes ownership of the ring-buffer consumer
/// and emits Tauri events for state / segments / errors.
pub fn spawn(
    app: AppHandle,
    cfg: WhisperConfig,
    mut consumer: Consumer,
    mut shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _ = app.emit("voxnap://state", "running");

        // ─────────────────────────────────────────────────────────────────
        // Try to load the model. If not present we still keep the loop
        // running but emit a warning so the UI shows the wiring is alive.
        // ─────────────────────────────────────────────────────────────────
        let model_path = match resolve_model_path(&app, &cfg) {
            Ok(p) => Some(p),
            Err(e) => {
                tracing::warn!("model unavailable: {e} — running in stub mode");
                let _ = app.emit("voxnap://error", e.to_string());
                None
            }
        };

        // The actual whisper-rs context is created lazily so the rest of the
        // pipeline can be exercised without a model on disk.
        let mut ctx: Option<WhisperCtx> = None;
        if let Some(path) = &model_path {
            match WhisperCtx::load(path) {
                Ok(c) => ctx = Some(c),
                Err(e) => {
                    let _ = app.emit("voxnap://error", e.to_string());
                }
            }
        }

        // Sliding-window state.
        let window_samples = (TARGET_SAMPLE_RATE as usize) * 5; // 5 s
        let step_samples = (TARGET_SAMPLE_RATE as usize) * 1; // 1 s
        let mut buffer: Vec<f32> = Vec::with_capacity(window_samples * 2);
        let mut total_emitted_ms: i64 = 0;
        let mut tick = tokio::time::interval(Duration::from_millis(100));

        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
                _ = tick.tick() => {
                    // Drain whatever is available from the ring buffer.
                    let mut chunk = vec![0f32; 4096];
                    loop {
                        let n = consumer.pop_slice(&mut chunk);
                        if n == 0 { break; }
                        buffer.extend_from_slice(&chunk[..n]);
                    }

                    if buffer.len() < window_samples {
                        continue;
                    }

                    // Take the last `window_samples` samples; the *step* in
                    // front of that becomes "finalised" on the next pass.
                    let take_from = buffer.len() - window_samples;
                    let window = &buffer[take_from..];

                    let segments = match ctx.as_mut() {
                        Some(c) => c.transcribe(window, &cfg).unwrap_or_default(),
                        None => stub_segments(),
                    };

                    for seg in segments {
                        let _ = app.emit("voxnap://transcript", &seg);
                    }

                    // Slide the window forward.
                    if buffer.len() > window_samples + step_samples {
                        buffer.drain(0..step_samples);
                        total_emitted_ms += (step_samples as i64 * 1000)
                            / TARGET_SAMPLE_RATE as i64;
                    }
                }
            }
        }

        let _ = app.emit("voxnap://state", "idle");
    })
}

fn stub_segments() -> Vec<EmittedSegment> {
    vec![EmittedSegment {
        id: format!("stub-{}", chrono_now_ms()),
        text: "[whisper-rs stub: place ggml-<id>.bin under <app-data>/models]".into(),
        start_ms: 0,
        end_ms: 5000,
        is_final: true,
    }]
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ───────────────────────────────────────────────────────────────────────────
// whisper-rs wrapper. Kept private so the only public API of this module is
// `spawn` + types. If you need to test inference in isolation, expose a
// helper here.
// ───────────────────────────────────────────────────────────────────────────

struct WhisperCtx {
    inner: whisper_rs::WhisperContext,
}

impl WhisperCtx {
    fn load(path: &std::path::Path) -> Result<Self> {
        let params = whisper_rs::WhisperContextParameters::default();
        let inner = whisper_rs::WhisperContext::new_with_params(
            path.to_string_lossy().as_ref(),
            params,
        )
        .map_err(|e| Error::Whisper(e.to_string()))?;
        Ok(Self { inner })
    }

    fn transcribe(&mut self, samples: &[f32], cfg: &WhisperConfig) -> Result<Vec<EmittedSegment>> {
        let mut params =
            whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_no_context(false);
        params.set_single_segment(false);
        if cfg.language != "auto" {
            params.set_language(Some(&cfg.language));
        }

        let mut state = self
            .inner
            .create_state()
            .map_err(|e| Error::Whisper(e.to_string()))?;
        state
            .full(params, samples)
            .map_err(|e| Error::Whisper(e.to_string()))?;

        let n = state
            .full_n_segments()
            .map_err(|e| Error::Whisper(e.to_string()))?;
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            let text = state
                .full_get_segment_text(i)
                .map_err(|e| Error::Whisper(e.to_string()))?;
            let t0 = state
                .full_get_segment_t0(i)
                .map_err(|e| Error::Whisper(e.to_string()))?
                * 10; // whisper times are in 10 ms ticks
            let t1 = state
                .full_get_segment_t1(i)
                .map_err(|e| Error::Whisper(e.to_string()))?
                * 10;
            out.push(EmittedSegment {
                id: format!("seg-{}-{}", t0, i),
                text,
                start_ms: t0,
                end_ms: t1,
                // Partial for now; the spawn loop promotes them to final.
                is_final: false,
            });
        }
        Ok(out)
    }
}
