//! Whisper inference worker.
//!
//! This is the bridge between the cpal ring buffer (`audio.rs`) and the
//! webview. It owns a `whisper-rs` context and runs in a dedicated tokio
//! task so the UI thread is never blocked by inference.
//!
//! Streaming strategy
//! ------------------
//!
//! Sliding window with overlap:
//!
//!  • Accumulate ~`window_secs` of audio (e.g. 5s) into a rolling buffer.
//!  • Run `whisper.full()` on the latest window each tick.
//!  • Each whisper segment is rebased to **absolute timeline** (ms since
//!    capture started) and emitted with a stable id `seg-<absStartMs>`.
//!  • Segments are emitted as `isFinal: false` while their end-time still
//!    falls inside the next-step window. Once the window slides past them,
//!    they're re-emitted with `isFinal: true` and won't be touched again.
//!
//! The JS side's transcription store keys on `id` so partial → final is
//! a clean replace.
//!
//! Audio-level (RMS / peak) is computed on every drain pass and emitted
//! at `voxnap://audio-level` so the UI's waveform animates from the very
//! first frame, even before the first 5 s window is ready.
//!
//! Event names match `packages/core/src/engine/TauriEngine.ts`:
//!   • `voxnap://segment`
//!   • `voxnap://audio-level`
//!   • `voxnap://state-change`
//!   • `voxnap://error`

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use ringbuf::traits::Consumer as _;
use tokio::sync::watch;

use crate::audio::{Consumer, TARGET_SAMPLE_RATE};
use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperConfig {
    /// Logical model id, e.g. `"base.q5_1"` (matches `WhisperModelId` on JS).
    #[serde(default)]
    pub model_id: String,

    /// `"auto"` or an ISO-639-1 code understood by whisper.cpp.
    #[serde(default = "default_lang")]
    pub language: String,

    /// Override the directory where `ggml-<modelId>.bin` lives. Defaults to
    /// `<app-data>/models` and `<resource-dir>/models`.
    #[serde(default)]
    pub model_dir: Option<String>,

    /// Absolute path to a model file. Wins over `model_dir` and the
    /// default search if provided.
    #[serde(default)]
    pub model_path: Option<String>,

    /// Translate to English while transcribing.
    #[serde(default)]
    pub translate: bool,

    /// Number of CPU threads for whisper.cpp. `None` → leave as default.
    #[serde(default)]
    pub threads: Option<i32>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioLevelEvent {
    rms: f32,
    peak: f32,
    at: i64,
}

/// Locate the model file. Search order:
///   1. `cfg.model_path` if provided (must point to an existing file)
///   2. `cfg.model_dir` if provided
///   3. `<app-data>/models`
///   4. `<resource-dir>/models` (bundled)
pub fn resolve_model_path(app: &AppHandle, cfg: &WhisperConfig) -> Result<PathBuf> {
    if let Some(p) = &cfg.model_path {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
        return Err(Error::ModelMissing(p.clone()));
    }

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
/// and emits Tauri events for state / segments / level / errors.
pub fn spawn(
    app: AppHandle,
    cfg: WhisperConfig,
    mut consumer: Consumer,
    mut shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _ = app.emit("voxnap://state-change", "running");

        // ─────────────────────────────────────────────────────────────────
        // Try to load the model. If not present we still keep the loop
        // running (audio-level events flow) but we surface a clear error so
        // the UI can show "model-not-found".
        // ─────────────────────────────────────────────────────────────────
        let mut ctx: Option<WhisperCtx> = None;
        match resolve_model_path(&app, &cfg) {
            Ok(p) => match WhisperCtx::load(&p) {
                Ok(c) => {
                    tracing::info!("loaded model: {}", p.display());
                    ctx = Some(c);
                }
                Err(e) => {
                    tracing::error!("model load failed: {e}");
                    let _ = app.emit(
                        "voxnap://error",
                        EngineErrorEvent {
                            code: "model-load-failed",
                            message: e.to_string(),
                        },
                    );
                }
            },
            Err(e) => {
                tracing::warn!("model unavailable: {e}");
                let _ = app.emit(
                    "voxnap://error",
                    EngineErrorEvent {
                        code: "model-not-found",
                        message: e.to_string(),
                    },
                );
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Sliding-window state (in 16k mono float32 samples).
        // ─────────────────────────────────────────────────────────────────
        let sr = TARGET_SAMPLE_RATE as usize;
        let window_samples = sr * 5; // 5 s window
        let step_samples = sr; // 1 s step

        let mut buffer: Vec<f32> = Vec::with_capacity(window_samples * 2);
        // How many samples have already slid off the front of the buffer.
        let mut consumed_offset_samples: u64 = 0;
        // IDs we've already promoted to final — never re-emit.
        let mut finalized: HashSet<String> = HashSet::new();
        // Most recent partial we've emitted per id; lets us skip redundant
        // re-emits for unchanged interim segments.
        let mut last_partial_text: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        let mut tick = tokio::time::interval(Duration::from_millis(150));

        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
                _ = tick.tick() => {
                    // ── 1. Drain whatever the cpal callback has produced ──
                    let mut popped: Vec<f32> = Vec::new();
                    let mut chunk = vec![0f32; 4096];
                    loop {
                        let n = consumer.pop_slice(&mut chunk);
                        if n == 0 { break; }
                        popped.extend_from_slice(&chunk[..n]);
                    }

                    if !popped.is_empty() {
                        let (rms, peak) = level_of(&popped);
                        let _ = app.emit(
                            "voxnap://audio-level",
                            AudioLevelEvent { rms, peak, at: now_ms() },
                        );
                        buffer.extend_from_slice(&popped);
                    }

                    // Need at least a full window before we run inference.
                    if buffer.len() < window_samples {
                        continue;
                    }

                    // ── 2. Build the current window (the last 5 s) ────────
                    let window_start_in_buf = buffer.len() - window_samples;
                    let window_start_abs_samples =
                        consumed_offset_samples + window_start_in_buf as u64;
                    let window_start_abs_ms =
                        (window_start_abs_samples * 1000 / sr as u64) as i64;
                    let window = &buffer[window_start_in_buf..];

                    // Cheap energy-based VAD: skip whisper if the window is
                    // basically silent — saves a lot of CPU and avoids
                    // hallucinations on background noise.
                    let (win_rms, _) = level_of(window);
                    let speech = win_rms >= 0.012;

                    // ── 3. Run whisper (or skip on silence / no model) ────
                    let segments: Vec<RawSegment> = if speech {
                        match ctx.as_mut() {
                            Some(c) => c.transcribe(window, &cfg).unwrap_or_else(|e| {
                                tracing::error!("whisper transcribe failed: {e}");
                                let _ = app.emit(
                                    "voxnap://error",
                                    EngineErrorEvent {
                                        code: "engine-internal",
                                        message: e.to_string(),
                                    },
                                );
                                Vec::new()
                            }),
                            None => Vec::new(),
                        }
                    } else {
                        Vec::new()
                    };


                    // After the upcoming slide, the window starts here:
                    let next_window_start_abs_ms = window_start_abs_ms
                        + ((step_samples as u64) * 1000 / sr as u64) as i64;

                    for seg in segments {
                        let abs_start = window_start_abs_ms + seg.start_ms;
                        let abs_end = window_start_abs_ms + seg.end_ms;
                        let id = format!("seg-{}", abs_start);

                        // Already finalised on a previous pass — ignore.
                        if finalized.contains(&id) {
                            continue;
                        }

                        // Promote to final if its end-time is fully behind
                        // the *next* window — i.e. whisper won't see those
                        // samples again, so the text won't change anymore.
                        let is_final = abs_end <= next_window_start_abs_ms;

                        let text = seg.text.trim().to_string();
                        if text.is_empty() {
                            continue;
                        }

                        // Skip noisy re-emits when the partial text hasn't
                        // changed since the last tick.
                        if !is_final {
                            if let Some(prev) = last_partial_text.get(&id) {
                                if prev == &text {
                                    continue;
                                }
                            }
                            last_partial_text.insert(id.clone(), text.clone());
                        } else {
                            last_partial_text.remove(&id);
                            finalized.insert(id.clone());
                        }

                        let language = if cfg.language == "auto" {
                            None
                        } else {
                            Some(cfg.language.clone())
                        };
                        let _ = app.emit(
                            "voxnap://segment",
                            EmittedSegment {
                                id,
                                text,
                                start_ms: abs_start,
                                end_ms: abs_end,
                                is_final,
                                confidence: seg.confidence,
                                language,
                            },
                        );
                    }

                    // ── 4. Slide the window forward by `step_samples` ────
                    if buffer.len() >= window_samples + step_samples {
                        buffer.drain(0..step_samples);
                        consumed_offset_samples += step_samples as u64;
                    }
                }
            }
        }

        let _ = app.emit("voxnap://state-change", "ready");
    })
}

#[derive(Debug, Clone, Serialize)]
struct EngineErrorEvent {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone)]
struct RawSegment {
    text: String,
    start_ms: i64,
    end_ms: i64,
    confidence: Option<f32>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn level_of(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f32;
    for &s in samples {
        sum_sq += (s as f64) * (s as f64);
        let a = s.abs();
        if a > peak {
            peak = a;
        }
    }
    let rms = (sum_sq / samples.len() as f64).sqrt() as f32;
    (rms.min(1.0), peak.min(1.0))
}

// ───────────────────────────────────────────────────────────────────────────
// whisper-rs wrapper. Kept private so the only public API of this module is
// `spawn` + types.
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

    fn transcribe(&mut self, samples: &[f32], cfg: &WhisperConfig) -> Result<Vec<RawSegment>> {
        let mut params =
            whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_no_context(true);
        params.set_single_segment(false);
        params.set_translate(cfg.translate);
        params.set_suppress_blank(true);
        params.set_suppress_non_speech_tokens(true);
        if cfg.language != "auto" {
            params.set_language(Some(&cfg.language));
        }
        if let Some(n) = cfg.threads {
            params.set_n_threads(n);
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
            // Whisper times are in 10 ms ticks.
            let t0 = state
                .full_get_segment_t0(i)
                .map_err(|e| Error::Whisper(e.to_string()))?
                * 10;
            let t1 = state
                .full_get_segment_t1(i)
                .map_err(|e| Error::Whisper(e.to_string()))?
                * 10;

            // Approx confidence from token probabilities (mean exp(prob)).
            let confidence = (|| -> Option<f32> {
                let n_tok = state.full_n_tokens(i).ok()?;
                if n_tok <= 0 {
                    return None;
                }
                let mut sum = 0.0f32;
                let mut count = 0i32;
                for tok in 0..n_tok {
                    if let Ok(td) = state.full_get_token_data(i, tok) {
                        sum += td.p;
                        count += 1;
                    }
                }
                if count == 0 {
                    None
                } else {
                    Some((sum / count as f32).clamp(0.0, 1.0))
                }
            })();

            out.push(RawSegment {
                text,
                start_ms: t0,
                end_ms: t1,
                confidence,
            });
        }
        Ok(out)
    }
}
