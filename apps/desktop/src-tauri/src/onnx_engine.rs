//! ONNX Runtime parallel inference pipeline.
//!
//! Phase 2A: full sync `transcribe(samples) -> String` API. The encoder
//! runs once per 30 s chunk; the decoder is invoked for each new token
//! with the **full prefix re-fed** (no past-KV cache). That is O(n²) in
//! the number of tokens but for Whisper's 224-token cap it's still
//! interactive on CPU, and crucially it lets us validate the entire
//! NPU/GPU plumbing without porting the per-layer KV-cache rename
//! bookkeeping that `decoder_with_past.onnx` requires. KV-cache reuse
//! drops in cleanly in Phase 2B without changing this module's public
//! API (`transcribe`).
//!
//! Pipeline diagram:
//!
//! ```text
//!   PCM @ 16 kHz
//!       │
//!       ▼  mel::log_mel_spectrogram
//!   mel f32[1, 80, 3000]
//!       │
//!       ▼  encoder.onnx  (once)
//!   encoder_states f32[1, 1500, d_model]
//!       │
//!       ▼  decoder.onnx  (loop until EOT, max 224 steps)
//!   logits f32[1, T, vocab]   →   argmax last → next token
//! ```
//!
//! On-disk model layout (matches HuggingFace `Xenova/whisper-base.en`):
//!
//! ```text
//!   <models-dir>/onnx/<modelId>/
//!       ├── encoder.onnx
//!       ├── decoder.onnx
//!       └── tokenizer.json
//! ```
//!
//! Phase 2B (next): KV-cache reuse via `decoder_with_past.onnx` (turns
//! the loop from O(n²) to O(n)) and a tokio task / mpsc-based streaming
//! API matching `whisper::spawn`. Phase 2C: timestamp tokens + small
//! beam search.

#![allow(dead_code)] // Phase 2A: still wired through stub; full dispatch lands in Phase 2B.

use std::path::{Path, PathBuf};

use ndarray::{Array1, Array2, Array3, Axis};
use ort::value::TensorRef;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::mel;
use crate::whisper_tokens::WhisperTokenizer;

// ───────────────────────────────────────────────────────────────────────────
// Public configuration
// ───────────────────────────────────────────────────────────────────────────

/// Runtime configuration for the ONNX pipeline. Parallels `WhisperConfig`
/// in `whisper.rs` so the dispatcher in `commands.rs` can branch on
/// `compute_backend` and pick the right pipeline without converting types.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxConfig {
    /// Logical model id, e.g. `"base.en"`. The on-disk layout is
    /// `<models-dir>/onnx/<modelId>/{encoder,decoder}.onnx`.
    pub model_id: String,

    /// Language hint (`"auto"` or ISO-639-1).
    #[serde(default = "default_lang")]
    pub language: String,

    /// Optional override for the directory containing the ONNX bundle.
    pub model_dir: Option<String>,

    /// Translate to English while transcribing.
    #[serde(default)]
    pub translate: bool,

    /// Number of intra-op threads. `None` → ORT default.
    pub threads: Option<i32>,

    /// User's compute-backend pick (`"npu" | "gpu" | "cpu" | "auto"`).
    /// Drives EP selection.
    #[serde(default)]
    pub compute_backend: Option<String>,
}

fn default_lang() -> String {
    "auto".into()
}

// ───────────────────────────────────────────────────────────────────────────
// Execution-provider dispatch
// ───────────────────────────────────────────────────────────────────────────

/// Build the list of EPs to register on the SessionBuilder, ordered by
/// preference. `ort` skips EPs whose feature flag isn't set or whose
/// runtime DLLs are missing, so this list is always safe to pass.
///
/// `"auto"` ⇒ NPU > dedicated GPU > integrated GPU > CPU.
/// `"npu"`  ⇒ Hexagon, OpenVINO-NPU, or CoreML — never falls through to GPU.
/// `"gpu"`  ⇒ CUDA, DirectML, OpenVINO-GPU, or CoreML.
/// `"cpu"`  ⇒ empty list — forces ORT to use the implicit CPU fallback.
#[allow(unused_variables)]
fn build_ep_list(compute_backend: Option<&str>) -> Vec<ort::ep::ExecutionProviderDispatch> {
    let mut out: Vec<ort::ep::ExecutionProviderDispatch> = Vec::new();

    let want_npu = matches!(compute_backend, None | Some("auto") | Some("npu"));
    let want_gpu = matches!(compute_backend, None | Some("auto") | Some("gpu"));

    #[cfg(feature = "ort-qnn")]
    if want_npu {
        out.push(ort::ep::QNN::default().build());
    }
    #[cfg(feature = "ort-openvino")]
    if want_npu {
        out.push(ort::ep::OpenVINO::default().with_device_type("NPU").build());
    }
    #[cfg(feature = "ort-coreml")]
    if want_npu || want_gpu {
        out.push(ort::ep::CoreML::default().build());
    }
    #[cfg(feature = "ort-cuda")]
    if want_gpu {
        out.push(ort::ep::CUDA::default().with_device_id(0).build());
    }
    #[cfg(feature = "ort-directml")]
    if want_gpu {
        out.push(ort::ep::DirectML::default().with_device_id(0).build());
    }
    #[cfg(feature = "ort-openvino")]
    if want_gpu {
        out.push(ort::ep::OpenVINO::default().with_device_type("GPU").build());
    }

    out
}

// ───────────────────────────────────────────────────────────────────────────
// Model resolution
// ───────────────────────────────────────────────────────────────────────────

/// Resolve the directory holding the ONNX bundle for `cfg.model_id`.
pub fn resolve_model_dir(app: &AppHandle, cfg: &OnnxConfig) -> Result<PathBuf> {
    if cfg.model_id.is_empty() {
        return Err(Error::Other("ONNX modelId is empty".into()));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = &cfg.model_dir {
        candidates.push(PathBuf::from(dir));
    }
    if let Ok(p) = app.path().app_data_dir() {
        candidates.push(p.join("models").join("onnx").join(&cfg.model_id));
    }
    if let Ok(p) = app.path().resource_dir() {
        candidates.push(p.join("models").join("onnx").join(&cfg.model_id));
    }
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
        let mut cur: Option<&Path> = Some(root.as_path());
        for _ in 0..8 {
            let Some(d) = cur else { break };
            candidates.push(d.join("models").join("onnx").join(&cfg.model_id));
            cur = d.parent();
        }
    }

    for c in candidates {
        if c.join("encoder.onnx").is_file() {
            return Ok(c);
        }
    }
    Err(Error::ModelMissing(format!(
        "ONNX bundle for model id `{}` (need encoder.onnx)",
        cfg.model_id
    )))
}

// ───────────────────────────────────────────────────────────────────────────
// Engine
// ───────────────────────────────────────────────────────────────────────────

/// Loaded ORT sessions for one Whisper model.
pub struct OnnxWhisperEngine {
    pub encoder: ort::session::Session,
    pub decoder: ort::session::Session,
    pub tokenizer: WhisperTokenizer,
    pub model_dir: PathBuf,
    pub active_ep: String,
    pub language: String,
    pub translate: bool,
}

impl OnnxWhisperEngine {
    /// Build an `OnnxWhisperEngine` with the user's preferred EP.
    pub fn load(app: &AppHandle, cfg: &OnnxConfig) -> Result<Self> {
        let dir = resolve_model_dir(app, cfg)?;
        let encoder_path = dir.join("encoder.onnx");
        let decoder_path = dir.join("decoder.onnx");
        let tokenizer_path = dir.join("tokenizer.json");

        for p in [&decoder_path, &tokenizer_path] {
            if !p.is_file() {
                return Err(Error::ModelMissing(format!(
                    "missing required file: {}",
                    p.display()
                )));
            }
        }

        tracing::info!(
            backend = cfg.compute_backend.as_deref().unwrap_or("auto"),
            model = %cfg.model_id,
            dir = %dir.display(),
            "loading ONNX Whisper sessions"
        );

        let _ = ort::init().commit();

        let make_session =
            |path: &Path, ep_label: &mut String| -> Result<ort::session::Session> {
                let mut builder = ort::session::Session::builder()
                    .map_err(|e| Error::Other(format!("ort builder: {e}")))?;
                if let Some(threads) = cfg.threads {
                    builder = builder
                        .with_intra_threads(threads as usize)
                        .map_err(|e| Error::Other(format!("ort threads: {e}")))?;
                }
                let eps = build_ep_list(cfg.compute_backend.as_deref());
                if !eps.is_empty() {
                    if ep_label.is_empty() {
                        if let Some(first) = eps.first() {
                            *ep_label = format!("{first:?}");
                        }
                    }
                    builder = builder
                        .with_execution_providers(eps)
                        .map_err(|e| Error::Other(format!("ort EP registration: {e}")))?;
                }
                builder
                    .commit_from_file(path)
                    .map_err(|e| Error::Other(format!("load {}: {e}", path.display())))
            };

        let mut active_ep = String::new();
        let encoder = make_session(&encoder_path, &mut active_ep)?;
        let decoder = make_session(&decoder_path, &mut active_ep)?;
        if active_ep.is_empty() {
            active_ep = "cpu".into();
        }

        let english_only = cfg.model_id.contains(".en") || cfg.model_id.ends_with("-en");
        let tokenizer = WhisperTokenizer::load(&tokenizer_path, english_only)?;

        Ok(Self {
            encoder,
            decoder,
            tokenizer,
            model_dir: dir,
            active_ep,
            language: if cfg.language.is_empty() {
                "en".into()
            } else {
                cfg.language.clone()
            },
            translate: cfg.translate,
        })
    }

    /// Transcribe a single 16 kHz mono PCM utterance into text.
    ///
    /// Greedy decoding, no beam search, no timestamps. Intentionally
    /// simple so the wiring is auditable end-to-end. Phase 2B replaces
    /// the inner loop with `decoder_with_past.onnx` (KV cache reuse) so
    /// throughput is O(n) instead of O(n²); Phase 2C adds beam search +
    /// timestamps for word-level timing.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String> {
        // 1) Features.
        let mel_arr = mel::log_mel_spectrogram(samples); // (80, 3000)
        let mel_input: Array3<f32> = mel_arr.insert_axis(Axis(0)); // (1, 80, 3000)

        // 2) Encoder forward.
        let mel_tensor = TensorRef::from_array_view(&mel_input)
            .map_err(|e| Error::Other(format!("mel tensor: {e}")))?;
        let encoder_outputs = self
            .encoder
            .run(ort::inputs![mel_tensor])
            .map_err(|e| Error::Other(format!("encoder.run: {e}")))?;
        // Recent HF exports name the output `encoder_hidden_states`;
        // older ones used `last_hidden_state`. Try both.
        let encoder_states_array = encoder_outputs
            .get("encoder_hidden_states")
            .or_else(|| encoder_outputs.get("last_hidden_state"))
            .ok_or_else(|| Error::Other("encoder did not emit hidden states".into()))?
            .try_extract_array::<f32>()
            .map_err(|e| Error::Other(format!("encoder output extract: {e}")))?
            .into_owned();
        // Shape into (1, 1500, d_model) — try_extract_array gives us the
        // raw shape from ONNX so this is already 3-D, just rebound.
        let encoder_states: Array3<f32> = encoder_states_array
            .into_dimensionality()
            .map_err(|e| Error::Other(format!("encoder shape: {e}")))?;

        // 3) Decoder prefix.
        let prefix = self.tokenizer.sot_prefix(&self.language, self.translate);
        let mut input_ids: Vec<i64> = prefix.iter().map(|&t| t as i64).collect();

        // 4) Greedy autoregressive loop.
        const MAX_DECODE_STEPS: usize = 224;
        let mut emitted: Vec<u32> = Vec::with_capacity(MAX_DECODE_STEPS);

        for _ in 0..MAX_DECODE_STEPS {
            let ids_arr = Array2::<i64>::from_shape_vec(
                (1, input_ids.len()),
                input_ids.clone(),
            )
            .map_err(|e| Error::Other(format!("decoder ids shape: {e}")))?;

            let ids_tensor = TensorRef::from_array_view(&ids_arr)
                .map_err(|e| Error::Other(format!("ids tensor: {e}")))?;
            let enc_tensor = TensorRef::from_array_view(&encoder_states)
                .map_err(|e| Error::Other(format!("encoder tensor: {e}")))?;

            let outputs = self
                .decoder
                .run(ort::inputs![
                    "input_ids" => ids_tensor,
                    "encoder_hidden_states" => enc_tensor,
                ])
                .map_err(|e| Error::Other(format!("decoder.run: {e}")))?;

            let logits = outputs
                .get("logits")
                .ok_or_else(|| Error::Other("decoder did not emit logits".into()))?
                .try_extract_array::<f32>()
                .map_err(|e| Error::Other(format!("logits extract: {e}")))?
                .into_owned();
            // Logits are (1, T, vocab); take the last position's row.
            let logits3: Array3<f32> = logits
                .into_dimensionality()
                .map_err(|e| Error::Other(format!("logits shape: {e}")))?;
            let last = logits3.index_axis(Axis(1), logits3.shape()[1] - 1);
            let next_id = argmax_u32(&last.to_owned().into_dimensionality::<ndarray::Ix1>().unwrap());

            if self.tokenizer.is_terminal(next_id) {
                break;
            }
            emitted.push(next_id);
            input_ids.push(next_id as i64);
        }

        self.tokenizer.decode(&emitted)
    }
}

/// Argmax over a 1-D tensor of f32. Returns the index as u32 (token id type).
fn argmax_u32(v: &Array1<f32>) -> u32 {
    let mut best = 0usize;
    let mut best_val = f32::NEG_INFINITY;
    for (i, x) in v.iter().enumerate() {
        if *x > best_val {
            best_val = *x;
            best = i;
        }
    }
    best as u32
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 2A entry points
// ───────────────────────────────────────────────────────────────────────────

/// Load the engine and transcribe a single utterance synchronously.
pub fn transcribe_once(
    app: &AppHandle,
    cfg: &OnnxConfig,
    samples: &[f32],
) -> Result<(String, String)> {
    let mut engine = OnnxWhisperEngine::load(app, cfg)?;
    let text = engine.transcribe(samples)?;
    Ok((text, engine.active_ep))
}

/// Phase 1 stub kept for API stability. Loads the engine without running
/// inference so callers can validate model + EP wiring on real hardware.
pub fn spawn_stub(app: AppHandle, cfg: OnnxConfig) -> Result<OnnxWhisperEngine> {
    let engine = OnnxWhisperEngine::load(&app, &cfg)?;
    tracing::info!(
        active_ep = %engine.active_ep,
        model_dir = %engine.model_dir.display(),
        "ONNX engine ready (Phase 2A — sync transcribe available; streaming wiring pending)"
    );
    Ok(engine)
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 2B — streaming spawn
// ───────────────────────────────────────────────────────────────────────────

use std::collections::VecDeque;
use std::time::Duration;

use ringbuf::traits::Consumer as _;
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::watch;

use crate::audio::{Consumer, TARGET_SAMPLE_RATE};
use crate::whisper::{level_of, now_ms, EmittedSegment, EngineErrorEvent};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioLevelEvent {
    rms: f32,
    peak: f32,
    at: i64,
}

/// Spawn the ONNX inference task. Mirrors `whisper::spawn` but routes
/// every utterance through `OnnxWhisperEngine::transcribe`. The audio
/// pipeline (cpal → ring buffer → VAD-driven utterance segmentation) is
/// identical so the two engines produce the same `voxnap://segment`
/// stream and the UI doesn't need to care which one is in use.
///
/// Differences from `whisper::spawn`:
///   • Greedy decoding only — no beam search yet (Phase 2C).
///   • No partial emissions during a long utterance — Phase 2A's
///     `transcribe()` blocks for the full decode, so emitting a
///     partial would mean *another* full decode mid-utterance, which
///     defeats the latency point. Phase 2B revisits this once KV-cache
///     reuse is in: a partial-decode shortcut on the in-progress
///     prefix becomes cheap enough to fire every 1.5 s like whisper.cpp.
///   • Final-only emission keeps the dispatcher honest while we get
///     the NPU/GPU path verified end-to-end.
pub fn spawn(
    app: AppHandle,
    cfg: OnnxConfig,
    mut consumer: Consumer,
    mut shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _ = app.emit("voxnap://state-change", "running");

        // ─── Load engine. On failure we keep the loop running so audio
        //     levels still flow, matching `whisper::spawn` behaviour. ────
        let mut engine: Option<OnnxWhisperEngine> = match OnnxWhisperEngine::load(&app, &cfg) {
            Ok(e) => {
                tracing::info!(
                    active_ep = %e.active_ep,
                    model_dir = %e.model_dir.display(),
                    "ONNX engine loaded"
                );
                Some(e)
            }
            Err(err) => {
                tracing::error!("ONNX engine load failed: {err}");
                let _ = app.emit(
                    "voxnap://error",
                    EngineErrorEvent {
                        code: "model-load-failed",
                        message: err.to_string(),
                    },
                );
                None
            }
        };

        // ─── VAD / segmentation state — copy of `whisper::spawn` knobs.
        let sr = TARGET_SAMPLE_RATE as usize;
        let frame_samples = (sr * 30) / 1000;
        let vad_threshold = 0.012f32;
        let min_silence_samples: usize = (sr * 600) / 1000;
        let min_speech_samples: usize = (sr * 250) / 1000;
        let max_utterance_samples: usize = sr * 15;
        let tail_keep_samples: usize = sr / 10;
        let preroll_samples: usize = sr / 5;

        let mut preroll: VecDeque<f32> = VecDeque::with_capacity(preroll_samples + 1);
        let mut utterance: Vec<f32> = Vec::with_capacity(sr * 5);
        let mut utterance_start_ms: Option<i64> = None;
        let mut trailing_silence_samples: usize = 0;
        let mut consumed_offset_samples: u64 = 0;

        let mut tick = tokio::time::interval(Duration::from_millis(100));

        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        if utterance.len() >= min_speech_samples {
                            let start_ms = utterance_start_ms.unwrap_or(0);
                            finalise_onnx_utterance(
                                &app,
                                engine.as_mut(),
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
                    let mut popped: Vec<f32> = Vec::new();
                    let mut chunk = vec![0f32; 4096];
                    loop {
                        let n = consumer.pop_slice(&mut chunk);
                        if n == 0 { break; }
                        popped.extend_from_slice(&chunk[..n]);
                    }
                    if popped.is_empty() {
                        continue;
                    }

                    let (rms, peak) = level_of(&popped);
                    let _ = app.emit(
                        "voxnap://audio-level",
                        AudioLevelEvent { rms, peak, at: now_ms() },
                    );

                    let mut frame_start = 0usize;
                    while frame_start < popped.len() {
                        let frame_end = (frame_start + frame_samples).min(popped.len());
                        let frame = &popped[frame_start..frame_end];
                        let frame_abs_start = consumed_offset_samples + frame_start as u64;

                        let (frame_rms, _) = level_of(frame);
                        let is_speech = frame_rms >= vad_threshold;

                        if utterance_start_ms.is_some() {
                            utterance.extend_from_slice(frame);
                            if is_speech {
                                trailing_silence_samples = 0;
                            } else {
                                trailing_silence_samples += frame.len();
                            }

                            let speech_samples = utterance
                                .len()
                                .saturating_sub(trailing_silence_samples);
                            let end_by_silence = trailing_silence_samples >= min_silence_samples
                                && speech_samples >= min_speech_samples;
                            let end_by_length = utterance.len() >= max_utterance_samples;

                            if end_by_silence || end_by_length {
                                let trim = trailing_silence_samples
                                    .saturating_sub(tail_keep_samples);
                                if trim > 0 && utterance.len() > trim {
                                    let new_len = utterance.len() - trim;
                                    utterance.truncate(new_len);
                                }
                                let start_ms = utterance_start_ms.unwrap();
                                finalise_onnx_utterance(
                                    &app,
                                    engine.as_mut(),
                                    &cfg,
                                    &utterance,
                                    start_ms,
                                    sr,
                                );
                                utterance.clear();
                                utterance_start_ms = None;
                                trailing_silence_samples = 0;
                            }
                        } else {
                            for &s in frame {
                                if preroll.len() == preroll_samples {
                                    preroll.pop_front();
                                }
                                preroll.push_back(s);
                            }
                            if is_speech {
                                let preroll_len = preroll.len() as u64;
                                let utt_offset = frame_abs_start.saturating_sub(preroll_len);
                                let start_ms = (utt_offset * 1000 / sr as u64) as i64;
                                utterance.clear();
                                utterance.reserve(preroll.len() + frame.len());
                                utterance.extend(preroll.drain(..));
                                utterance.extend_from_slice(frame);
                                utterance_start_ms = Some(start_ms);
                                trailing_silence_samples = 0;
                            }
                        }
                        frame_start = frame_end;
                    }
                    consumed_offset_samples += popped.len() as u64;
                }
            }
        }

        let _ = app.emit("voxnap://state-change", "ready");
    })
}

/// Run the ONNX engine on a finished utterance and emit a final segment.
fn finalise_onnx_utterance(
    app: &AppHandle,
    engine: Option<&mut OnnxWhisperEngine>,
    cfg: &OnnxConfig,
    utterance: &[f32],
    start_ms: i64,
    sr: usize,
) {
    let len_ms = (utterance.len() as i64 * 1000) / sr as i64;
    let end_ms = start_ms + len_ms;
    let Some(e) = engine else { return };

    match e.transcribe(utterance) {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return;
            }
            let _ = app.emit(
                "voxnap://segment",
                EmittedSegment {
                    id: format!("seg-{start_ms}"),
                    text: trimmed.to_string(),
                    start_ms,
                    end_ms,
                    is_final: true,
                    confidence: None,
                    language: if cfg.language == "auto" || cfg.language.is_empty() {
                        None
                    } else {
                        Some(cfg.language.clone())
                    },
                },
            );
        }
        Err(err) => {
            tracing::error!("onnx transcribe (final) failed: {err}");
            let _ = app.emit(
                "voxnap://error",
                EngineErrorEvent {
                    code: "engine-internal",
                    message: err.to_string(),
                },
            );
        }
    }
}
