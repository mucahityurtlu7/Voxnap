//! Whisper inference worker.
//!
//! This is the bridge between the cpal ring buffer (`audio.rs`) and the
//! webview. It owns a `whisper-rs` context and runs in a dedicated tokio
//! task so the UI thread is never blocked by inference.
//!
//! Streaming strategy
//! ------------------
//!
//! VAD-driven **utterance segmentation** (NOT a sliding window):
//!
//!  • Continuously drain audio from the ring buffer in ~30 ms frames.
//!  • Track per-frame RMS to decide speech vs. silence (with hysteresis).
//!  • While silent: keep a small 200 ms pre-roll buffer rolling so that the
//!    very first phoneme of the next utterance is not lost.
//!  • On speech onset: open a new utterance and start accumulating frames.
//!  • Every ~1500 ms during an active utterance: run whisper on the
//!    accumulated audio so far and emit it as a *partial* segment with a
//!    stable `seg-live` id. The UI replaces the same interim slot each
//!    time, so the live transcript appears to grow naturally.
//!  • On silence ≥ 600 ms (or hard cap of 15 s): run whisper one last time
//!    on the full utterance, emit it as `is_final: true` with a unique
//!    timestamp-based id (`seg-<startMs>`), and reset state.
//!
//! Why this matters
//! ----------------
//! The previous design ran whisper on every overlapping 5 s window once
//! per second. That re-transcribed the same audio up to five times,
//! producing slightly different segment boundaries each pass, which broke
//! ID stability and resulted in *the same words being emitted multiple
//! times as different finals*. It also made hallucinations on background
//! noise very common because whisper hates being fed the same audio
//! repeatedly with no context.
//!
//! With utterance-based segmentation each chunk of speech is transcribed
//! exactly once (plus a few interim peeks while it is still in progress),
//! which fixes both the duplication problem and the hallucination
//! problem in one shot.
//!
//! Audio-level (RMS / peak) is computed on every drain pass and emitted
//! at `voxnap://audio-level` so the UI's waveform animates from the very
//! first frame, even before the first utterance is finalised.
//!
//! Event names match `packages/core/src/engine/TauriEngine.ts`:
//!   • `voxnap://segment`
//!   • `voxnap://audio-level`
//!   • `voxnap://state-change`
//!   • `voxnap://error`

use std::collections::VecDeque;
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

    /// Energy-based VAD RMS threshold. A frame counts as "speech" only when
    /// its RMS is above this value. `None` → use the built-in default
    /// (0.012). Set to `Some(0.0)` to effectively disable VAD.
    #[serde(default)]
    pub vad_threshold: Option<f32>,

    /// When `false` VAD is bypassed and the engine treats every frame as
    /// speech. Defaults to `true`.
    #[serde(default = "default_vad_enabled")]
    pub vad_enabled: bool,

    /// Where the model should run.
    ///
    /// `"auto"` (default) lets whisper.cpp pick the best backend that was
    /// compiled in (NPU > GPU > CPU). `"cpu"` forces pure-CPU inference
    /// even on hardware where Metal/CUDA/CoreML are available — useful
    /// for diagnosing accelerator-specific bugs. `"gpu"` and `"npu"`
    /// behave like `"auto"` today (whisper.cpp doesn't expose a finer
    /// runtime knob); they're accepted so the JS side and the user's
    /// stored preference always round-trip cleanly.
    #[serde(default)]
    pub compute_backend: Option<String>,
}

fn default_vad_enabled() -> bool {
    true
}

fn default_lang() -> String {
    "auto".into()
}

/// Translate a JS `ComputeBackend` string into the `use_gpu` flag that
/// whisper-rs accepts. `None` / unknown / `"auto"` → leave the host's
/// best accelerator on, `"cpu"` → force CPU.
fn use_gpu_for(backend: Option<&str>) -> bool {
    match backend {
        Some("cpu") => false,
        // "auto" / "gpu" / "npu" / unknown / unset → let whisper.cpp use
        // whatever accelerator the build linked in.
        _ => true,
    }
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
///   5. Dev-time fallbacks: walk up from the executable and the current
///      working directory looking for a `models/<file>` (this is what
///      `tauri dev` needs because the workspace `models/` folder is *not*
///      copied into `target/debug/` automatically — the
///      `tauri.conf.json` `bundle.resources` mapping only fires for
///      production bundles).
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

    // Dev fallbacks — walk up from the executable's directory and the
    // current working directory and accept the first `models/<file>` we
    // find. Capped at 8 hops so we never escape the repo.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        let mut cur: Option<&std::path::Path> = Some(root.as_path());
        for _ in 0..8 {
            let Some(dir) = cur else { break };
            candidates.push(dir.join("models").join(&file_name));
            cur = dir.parent();
        }
    }

    for c in &candidates {
        tracing::debug!("model candidate: {}", c.display());
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
            Ok(p) => match WhisperCtx::load(&p, &cfg) {
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
        // VAD-based segmentation state.
        //
        // All buffers are 16k mono float32. Sample counts are absolute (i.e.
        // since capture started) so timestamps survive across drains.
        // ─────────────────────────────────────────────────────────────────
        let sr = TARGET_SAMPLE_RATE as usize;
        let frame_samples = (sr * 30) / 1000; // 30 ms = 480 samples

        // VAD knobs
        let vad_enabled = cfg.vad_enabled;
        let vad_threshold = cfg.vad_threshold.unwrap_or(0.012);
        // Hysteresis: how much consecutive silence ends an utterance, and
        // how short a "speech burst" we will still bother transcribing.
        let min_silence_samples: usize = (sr * 600) / 1000; // 600 ms
        let min_speech_samples: usize = (sr * 250) / 1000; //  250 ms
        let max_utterance_samples: usize = sr * 15; // 15 s hard cap
        // Tail of trailing silence kept in the audio fed to whisper so the
        // last syllable doesn't get clipped.
        let tail_keep_samples: usize = sr / 10; // 100 ms
        // Pre-roll: rolling buffer kept *during* silence so we can prepend
        // it to a new utterance and keep the leading consonant.
        let preroll_samples: usize = sr / 5; // 200 ms

        let mut preroll: VecDeque<f32> = VecDeque::with_capacity(preroll_samples + 1);

        // Active utterance.
        let mut utterance: Vec<f32> = Vec::with_capacity(sr * 5);
        let mut utterance_start_ms: Option<i64> = None;
        let mut trailing_silence_samples: usize = 0;

        // Total samples drained from the ring buffer since `start`.
        let mut consumed_offset_samples: u64 = 0;

        // Partial-emission scheduling.
        let partial_interval = Duration::from_millis(1500);
        let mut next_partial_at = tokio::time::Instant::now() + partial_interval;
        let mut last_partial_text = String::new();

        let mut tick = tokio::time::interval(Duration::from_millis(100));

        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        // Best-effort flush of any speech that was in progress
                        // when the user hit stop. We don't want the last
                        // sentence to vanish.
                        if utterance.len() >= min_speech_samples {
                            let start_ms = utterance_start_ms.unwrap_or(0);
                            finalise_utterance(
                                &app,
                                ctx.as_mut(),
                                &cfg,
                                &utterance,
                                start_ms,
                                sr,
                            );
                        }
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

                    if popped.is_empty() {
                        // No audio this tick. Still let the partial timer run
                        // so an in-progress utterance can publish what it has.
                        emit_partial_if_due(
                            &app,
                            ctx.as_mut(),
                            &cfg,
                            &utterance,
                            utterance_start_ms,
                            min_speech_samples,
                            sr,
                            &mut next_partial_at,
                            partial_interval,
                            &mut last_partial_text,
                        );
                        continue;
                    }

                    // Surface a level reading immediately so the waveform
                    // never looks frozen even when whisper is idle.
                    let (rms, peak) = level_of(&popped);
                    let _ = app.emit(
                        "voxnap://audio-level",
                        AudioLevelEvent { rms, peak, at: now_ms() },
                    );

                    // ── 2. Walk the batch one VAD frame at a time ─────────
                    let mut frame_start = 0usize;
                    while frame_start < popped.len() {
                        let frame_end = (frame_start + frame_samples).min(popped.len());
                        let frame = &popped[frame_start..frame_end];
                        let frame_abs_start =
                            consumed_offset_samples + frame_start as u64;

                        let (frame_rms, _) = level_of(frame);
                        let is_speech = !vad_enabled || frame_rms >= vad_threshold;

                        if utterance_start_ms.is_some() {
                            // We're inside an utterance — keep accumulating.
                            utterance.extend_from_slice(frame);
                            if is_speech {
                                trailing_silence_samples = 0;
                            } else {
                                trailing_silence_samples += frame.len();
                            }

                            let speech_samples = utterance
                                .len()
                                .saturating_sub(trailing_silence_samples);
                            let end_by_silence = trailing_silence_samples
                                >= min_silence_samples
                                && speech_samples >= min_speech_samples;
                            let end_by_length = utterance.len() >= max_utterance_samples;

                            if end_by_silence || end_by_length {
                                // Trim most of the trailing silence — keep a
                                // short tail so the final syllable doesn't
                                // get clipped by whisper's end-of-audio.
                                let trim = trailing_silence_samples
                                    .saturating_sub(tail_keep_samples);
                                if trim > 0 && utterance.len() > trim {
                                    let new_len = utterance.len() - trim;
                                    utterance.truncate(new_len);
                                }

                                let start_ms = utterance_start_ms.unwrap();
                                finalise_utterance(
                                    &app,
                                    ctx.as_mut(),
                                    &cfg,
                                    &utterance,
                                    start_ms,
                                    sr,
                                );

                                // Reset state for the next utterance.
                                utterance.clear();
                                utterance_start_ms = None;
                                trailing_silence_samples = 0;
                                last_partial_text.clear();
                            }
                        } else {
                            // Idle — keep the rolling pre-roll fresh so the
                            // *next* utterance gets its leading edge.
                            for &s in frame {
                                if preroll.len() == preroll_samples {
                                    preroll.pop_front();
                                }
                                preroll.push_back(s);
                            }

                            if is_speech {
                                // Open a new utterance, prepending pre-roll.
                                let preroll_len = preroll.len() as u64;
                                let utt_offset =
                                    frame_abs_start.saturating_sub(preroll_len);
                                let start_ms =
                                    (utt_offset * 1000 / sr as u64) as i64;

                                utterance.clear();
                                utterance.reserve(preroll.len() + frame.len());
                                utterance.extend(preroll.drain(..));
                                utterance.extend_from_slice(frame);
                                utterance_start_ms = Some(start_ms);
                                trailing_silence_samples = 0;
                                last_partial_text.clear();
                                next_partial_at =
                                    tokio::time::Instant::now() + partial_interval;
                            }
                        }

                        frame_start = frame_end;
                    }

                    consumed_offset_samples += popped.len() as u64;

                    // ── 3. If a partial is due, emit it ───────────────────
                    emit_partial_if_due(
                        &app,
                        ctx.as_mut(),
                        &cfg,
                        &utterance,
                        utterance_start_ms,
                        min_speech_samples,
                        sr,
                        &mut next_partial_at,
                        partial_interval,
                        &mut last_partial_text,
                    );
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

fn lang_or_none(cfg: &WhisperConfig) -> Option<String> {
    if cfg.language == "auto" || cfg.language.is_empty() {
        None
    } else {
        Some(cfg.language.clone())
    }
}

fn combine_text(segments: &[RawSegment]) -> String {
    let mut out = String::new();
    for s in segments {
        let t = s.text.trim();
        if t.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

fn avg_confidence(segments: &[RawSegment]) -> Option<f32> {
    let confs: Vec<f32> = segments.iter().filter_map(|s| s.confidence).collect();
    if confs.is_empty() {
        None
    } else {
        Some(confs.iter().sum::<f32>() / confs.len() as f32)
    }
}

/// Run whisper on the in-progress utterance and emit it as a final segment.
fn finalise_utterance(
    app: &AppHandle,
    ctx: Option<&mut WhisperCtx>,
    cfg: &WhisperConfig,
    utterance: &[f32],
    start_ms: i64,
    sr: usize,
) {
    let len_ms = (utterance.len() as i64 * 1000) / sr as i64;
    let end_ms = start_ms + len_ms;
    let Some(c) = ctx else { return };

    match c.transcribe(utterance, cfg) {
        Ok(segments) => {
            let text = combine_text(&segments);
            if text.is_empty() {
                return;
            }
            let _ = app.emit(
                "voxnap://segment",
                EmittedSegment {
                    id: format!("seg-{start_ms}"),
                    text,
                    start_ms,
                    end_ms,
                    is_final: true,
                    confidence: avg_confidence(&segments),
                    language: lang_or_none(cfg),
                },
            );
        }
        Err(e) => {
            tracing::error!("whisper transcribe (final) failed: {e}");
            let _ = app.emit(
                "voxnap://error",
                EngineErrorEvent {
                    code: "engine-internal",
                    message: e.to_string(),
                },
            );
        }
    }
}

/// If the partial timer has fired and we have enough speech, run whisper on
/// the in-progress utterance and emit it as `seg-live`.
#[allow(clippy::too_many_arguments)]
fn emit_partial_if_due(
    app: &AppHandle,
    ctx: Option<&mut WhisperCtx>,
    cfg: &WhisperConfig,
    utterance: &[f32],
    utterance_start_ms: Option<i64>,
    min_speech_samples: usize,
    sr: usize,
    next_partial_at: &mut tokio::time::Instant,
    partial_interval: Duration,
    last_partial_text: &mut String,
) {
    let Some(start_ms) = utterance_start_ms else { return };
    if utterance.len() < min_speech_samples {
        return;
    }
    if tokio::time::Instant::now() < *next_partial_at {
        return;
    }
    *next_partial_at = tokio::time::Instant::now() + partial_interval;

    let Some(c) = ctx else { return };
    let Ok(segments) = c.transcribe(utterance, cfg) else { return };
    let text = combine_text(&segments);
    if text.is_empty() {
        return;
    }
    if &text == last_partial_text {
        // Nothing new to say; skip the emit so the UI doesn't re-render.
        return;
    }
    last_partial_text.clear();
    last_partial_text.push_str(&text);

    let len_ms = (utterance.len() as i64 * 1000) / sr as i64;
    let _ = app.emit(
        "voxnap://segment",
        EmittedSegment {
            id: "seg-live".to_string(),
            text,
            start_ms,
            end_ms: start_ms + len_ms,
            is_final: false,
            confidence: None,
            language: lang_or_none(cfg),
        },
    );
}

// ───────────────────────────────────────────────────────────────────────────
// whisper-rs wrapper. Kept private so the only public API of this module is
// `spawn` + types.
// ───────────────────────────────────────────────────────────────────────────

struct WhisperCtx {
    inner: whisper_rs::WhisperContext,
}

impl WhisperCtx {
    fn load(path: &std::path::Path, cfg: &WhisperConfig) -> Result<Self> {
        let mut params = whisper_rs::WhisperContextParameters::default();
        // whisper-rs's `use_gpu` is the master switch for CoreML / Metal /
        // CUDA depending on which feature was compiled in. Off ⇒ pure CPU.
        let use_gpu = use_gpu_for(cfg.compute_backend.as_deref());
        params.use_gpu(use_gpu);
        tracing::info!(
            backend = cfg.compute_backend.as_deref().unwrap_or("auto"),
            use_gpu,
            "loading whisper context"
        );
        let inner = whisper_rs::WhisperContext::new_with_params(
            path.to_string_lossy().as_ref(),
            params,
        )
        .map_err(|e| Error::Whisper(e.to_string()))?;
        Ok(Self { inner })
    }

    fn transcribe(&mut self, samples: &[f32], cfg: &WhisperConfig) -> Result<Vec<RawSegment>> {
        // BeamSearch with a small beam gives noticeably better quality than
        // Greedy (which the previous implementation used) without making
        // each utterance unbearably slow on CPU. Whisper.cpp authors
        // recommend 5 as a sane default for streaming-ish workloads.
        let mut params = whisper_rs::FullParams::new(
            whisper_rs::SamplingStrategy::BeamSearch {
                beam_size: 5,
                patience: 1.0,
            },
        );
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        // Disables the verbose C-level beam-search decoder logs
        // ("whisper_full_with_state: id = X, decoder = Y, token = ...").
        // The flags above only suppress higher-level progress/realtime output;
        // debug_mode is what gates the per-token beam trace.
        params.set_debug_mode(false);
        // We feed whisper a single complete utterance at a time, so:
        //   • no_context: don't carry tokens across utterances (each one
        //     stands on its own, which prevents the "model gets stuck on
        //     a hallucinated theme" failure mode).
        //   • single_segment: ask whisper to treat the buffer as one
        //     utterance instead of slicing it internally — cleaner output
        //     and avoids the boundary-flapping that plagued the old
        //     sliding-window code.
        params.set_no_context(true);
        params.set_single_segment(true);
        params.set_translate(cfg.translate);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);

        // Set language explicitly. `None` = let whisper auto-detect.
        // If we pass `Some("auto")` whisper.cpp interprets it as the
        // literal string "auto" and produces broken output.
        let lang = if cfg.language == "auto" || cfg.language.is_empty() {
            None
        } else {
            Some(cfg.language.as_str())
        };
        params.set_language(lang);

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

        let n = state.full_n_segments();
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            let seg = match state.get_segment(i) {
                Some(s) => s,
                None => continue,
            };

            // Whisper can split a multi-byte UTF-8 codepoint across the edge
            // of a sliding window, which makes the strict `to_str` bail with
            // `InvalidUtf8`. We fall back to the lossy variant so a single
            // bad byte doesn't kill the whole inference pass.
            let text = match seg.to_str() {
                Ok(t) => t.to_string(),
                Err(_) => match seg.to_str_lossy() {
                    Ok(t) => t.into_owned(),
                    Err(e) => {
                        tracing::warn!("skipping segment {i}: {e}");
                        continue;
                    }
                },
            };

            // Approx confidence from token probabilities (mean p).
            let n_tok = seg.n_tokens();
            let confidence = if n_tok > 0 {
                let mut sum = 0.0f32;
                let mut count = 0i32;
                for tok in 0..n_tok {
                    if let Some(t) = seg.get_token(tok) {
                        sum += t.token_data().p;
                        count += 1;
                    }
                }
                if count > 0 {
                    Some((sum / count as f32).clamp(0.0, 1.0))
                } else {
                    None
                }
            } else {
                None
            };

            out.push(RawSegment { text, confidence });
        }
        Ok(out)
    }
}
