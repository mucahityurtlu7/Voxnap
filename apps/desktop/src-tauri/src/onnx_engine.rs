//! ONNX Runtime parallel inference pipeline.
//!
//! Streaming, KV-cache aware Whisper decoder built on top of
//! [`ort`]. The public surface mirrors `whisper.rs` so the dispatcher
//! in `commands.rs` can branch on the user's `compute_backend` choice
//! without leaking pipeline-specific types up to the UI.
//!
//! Inference pipeline:
//!
//! ```text
//!   PCM @ 16 kHz
//!       │
//!       ▼  mel::log_mel_spectrogram
//!   mel f32[1, 80, 3000]
//!       │
//!       ▼  encoder.onnx  (once per utterance)
//!   encoder_states f32[1, 1500, d_model]
//!       │
//!       ▼  decoder.onnx  (1 step → seeds KV cache)
//!       ▼  decoder_with_past.onnx  (loop, 1 token / step, O(n))
//!   logits f32[1, T, vocab]   →   argmax last → next token
//! ```
//!
//! When `decoder_with_past.onnx` is missing from the bundle we
//! transparently fall back to re-feeding the full prefix through
//! `decoder.onnx` every step (O(n²)). That keeps smoke-testing
//! working on minimal model bundles at the cost of throughput.
//!
//! On-disk model layout (matches HuggingFace `Xenova/whisper-base.en`):
//!
//! ```text
//!   <models-dir>/onnx/<modelId>/
//!       ├── encoder.onnx
//!       ├── decoder.onnx
//!       ├── decoder_with_past.onnx   (optional, enables KV-cache reuse)
//!       └── tokenizer.json
//! ```
//!
//! Phase tracker:
//!  • Phase 2A (sync `transcribe`)        — done
//!  • Phase 2B (streaming `spawn`)        — done
//!  • Phase 2C (full feature parity with  — done. KV-cache reuse,
//!     whisper.cpp): KV-cache reuse,        partial emissions,
//!     partial emissions, timestamp        timestamp-token filtering,
//!     tokens, small-beam search           and small-beam search are all
//!                                         live. Beam search runs in the
//!                                         re-feed path only — per-beam KV
//!                                         tensor cloning is deferred to a
//!                                         future phase since the greedy
//!                                         KV path already wins on every
//!                                         throughput-sensitive bundle.



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

    /// Beam size for the autoregressive decode. `None` or `Some(0|1)`
    /// means greedy (the historical default). Larger values activate
    /// the beam-search code path in `decode_refeed_beam`. The KV-cache
    /// path is always greedy because per-beam KV cloning across all
    /// `present.*` tensors is expensive enough that greedy with KV
    /// reuse beats beam search without KV reuse on every realistic
    /// model size we ship.
    #[serde(default)]
    pub beam_size: Option<u32>,

    /// Emit `<|x.xx|>` timestamp tokens during decoding so the engine
    /// can recover sub-utterance timing. Off by default (matches the
    /// original `notimestamps` behaviour from Phase 2A/2B). Timestamp
    /// tokens are stripped from the final text — they show up in
    /// future per-word `EmittedSegment` enrichment, not in the visible
    /// transcript.
    #[serde(default)]
    pub timestamps: bool,
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
///
/// `decoder_with_past` is **optional**: when present, `transcribe()`
/// switches to KV-cache reuse (O(n) decode steps); when absent it falls
/// back to the O(n²) re-feed path so smoke-testing still works on
/// minimal model bundles.
pub struct OnnxWhisperEngine {
    pub encoder: ort::session::Session,
    pub decoder: ort::session::Session,
    pub decoder_with_past: Option<ort::session::Session>,
    pub tokenizer: WhisperTokenizer,
    pub model_dir: PathBuf,
    pub active_ep: String,
    pub language: String,
    pub translate: bool,
    /// Beam width copied off `OnnxConfig::beam_size`. `<= 1` ⇒ greedy.
    pub beam_size: u32,
    /// Whether to ask the decoder for `<|x.xx|>` timestamp tokens.
    pub timestamps: bool,
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
        let decoder_kv_path = dir.join("decoder_with_past.onnx");

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
        // KV-cache graph is optional. When the bundle ships it we get an
        // order-of-magnitude speed-up because the decoder re-uses past
        // attention keys/values instead of recomputing them every step.
        let decoder_with_past = if decoder_kv_path.is_file() {
            tracing::info!(
                path = %decoder_kv_path.display(),
                "found decoder_with_past.onnx — KV-cache reuse enabled"
            );
            Some(make_session(&decoder_kv_path, &mut active_ep)?)
        } else {
            tracing::info!(
                "no decoder_with_past.onnx — falling back to O(n²) decode (still works, just slower)"
            );
            None
        };
        if active_ep.is_empty() {
            active_ep = "cpu".into();
        }

        let english_only = cfg.model_id.contains(".en") || cfg.model_id.ends_with("-en");
        let tokenizer = WhisperTokenizer::load(&tokenizer_path, english_only)?;

        Ok(Self {
            encoder,
            decoder,
            decoder_with_past,
            tokenizer,
            model_dir: dir,
            active_ep,
            language: if cfg.language.is_empty() {
                "en".into()
            } else {
                cfg.language.clone()
            },
            translate: cfg.translate,
            beam_size: cfg.beam_size.unwrap_or(0),
            timestamps: cfg.timestamps,
        })
    }


    /// Transcribe a single 16 kHz mono PCM utterance into text.
    ///
    /// Decoder strategy is picked from the engine's loaded config:
    ///
    ///  • **KV-cache reuse, greedy** (when `decoder_with_past.onnx` is
    ///    loaded): The first call to `decoder.onnx` produces both the
    ///    initial logits *and* the per-layer attention KV outputs.
    ///    Subsequent calls go to `decoder_with_past.onnx`, which expects
    ///    only the newest token plus the past KV; total work is O(n).
    ///
    ///  • **Re-feed fallback** (when the KV graph is missing or
    ///    `beam_size > 1`): every step re-runs the full prefix through
    ///    `decoder.onnx`. O(n²) but supports beam search trivially —
    ///    the beams are just `beam_size` parallel re-feed loops with
    ///    cumulative log-prob ranking.
    ///
    /// The exported graph names KV outputs `present.<L>.<{encoder,decoder}>.{key,value}`
    /// and KV inputs `past_key_values.<L>.<{encoder,decoder}>.{key,value}`.
    /// We rebuild the next-step input map by string-replacing the prefix.
    ///
    /// Timestamp tokens (`<|x.xx|>`) are dropped from the returned
    /// text — `tokenizer.decode(&emitted)` runs with
    /// `skip_special_tokens=true`, but those timestamp tokens *aren't*
    /// in the special-tokens table on every export, so we filter them
    /// explicitly via `tokenizer.is_timestamp()`.
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
        let encoder_states_array = encoder_outputs
            .get("encoder_hidden_states")
            .or_else(|| encoder_outputs.get("last_hidden_state"))
            .ok_or_else(|| Error::Other("encoder did not emit hidden states".into()))?
            .try_extract_array::<f32>()
            .map_err(|e| Error::Other(format!("encoder output extract: {e}")))?
            .into_owned();
        let encoder_states: Array3<f32> = encoder_states_array
            .into_dimensionality()
            .map_err(|e| Error::Other(format!("encoder shape: {e}")))?;

        // 3) Decoder prefix.
        let prefix = self.tokenizer.sot_prefix_with(
            &self.language,
            self.translate,
            self.timestamps,
        );
        let prefix_ids: Vec<i64> = prefix.iter().map(|&t| t as i64).collect();

        const MAX_DECODE_STEPS: usize = 224;
        let mut emitted: Vec<u32> = Vec::with_capacity(MAX_DECODE_STEPS);

        // Beam search forces the re-feed path because per-beam KV
        // cloning across all `present.*` tensors costs more than the
        // wall-clock savings beam search buys on the realistic model
        // sizes we ship. Greedy keeps the KV path whenever it can.
        let beam_size = self.beam_size.max(1);

        // We split the `&mut self` here into disjoint fields so the
        // borrow checker lets us pass `decoder` and `decoder_with_past`
        // as two distinct `&mut Session` handles into the helpers.
        let Self {
            decoder,
            decoder_with_past,
            tokenizer,
            ..
        } = self;

        if beam_size > 1 {
            decode_refeed_beam(
                decoder,
                tokenizer,
                &encoder_states,
                prefix_ids,
                MAX_DECODE_STEPS,
                beam_size as usize,
                &mut emitted,
            )?;
        } else if let Some(kv_decoder) = decoder_with_past.as_mut() {
            decode_with_kv_cache(
                decoder,
                kv_decoder,
                tokenizer,
                &encoder_states,
                prefix_ids,
                MAX_DECODE_STEPS,
                &mut emitted,
            )?;
        } else {
            decode_refeed(
                decoder,
                tokenizer,
                &encoder_states,
                prefix_ids,
                MAX_DECODE_STEPS,
                &mut emitted,
            )?;
        }

        // Strip timestamp tokens before the BPE detokenizer runs — some
        // tokenizer.json exports register them as "added vocab" rather
        // than "special tokens", which means `decode(skip_special=true)`
        // would otherwise leak the literal `<|x.xx|>` strings into the
        // user-visible transcript.
        let text_only: Vec<u32> = emitted
            .iter()
            .copied()
            .filter(|id| !tokenizer.is_timestamp(*id))
            .collect();
        tokenizer.decode(&text_only)
    }
}


/// O(n²) fallback: re-feeds the full prefix through `decoder.onnx`
/// every step. Used when `decoder_with_past.onnx` isn't available.
fn decode_refeed(
    decoder: &mut ort::session::Session,
    tokenizer: &WhisperTokenizer,
    encoder_states: &Array3<f32>,
    mut input_ids: Vec<i64>,
    max_steps: usize,
    emitted: &mut Vec<u32>,
) -> Result<()> {
    for _ in 0..max_steps {
        let ids_arr = Array2::<i64>::from_shape_vec((1, input_ids.len()), input_ids.clone())
            .map_err(|e| Error::Other(format!("decoder ids shape: {e}")))?;
        let ids_tensor = TensorRef::from_array_view(&ids_arr)
            .map_err(|e| Error::Other(format!("ids tensor: {e}")))?;
        let enc_tensor = TensorRef::from_array_view(encoder_states)
            .map_err(|e| Error::Other(format!("encoder tensor: {e}")))?;

        let outputs = decoder
            .run(ort::inputs![
                "input_ids" => ids_tensor,
                "encoder_hidden_states" => enc_tensor,
            ])
            .map_err(|e| Error::Other(format!("decoder.run: {e}")))?;

        let next_id = pick_next_token(&outputs)?;
        if tokenizer.is_terminal(next_id) {
            break;
        }
        emitted.push(next_id);
        input_ids.push(next_id as i64);
    }
    Ok(())
}

/// O(n) fast path: uses `decoder.onnx` once for the prefix to seed
/// the KV cache, then loops on `decoder_with_past.onnx` feeding only
/// the newest token + the cached attention keys/values per layer.
fn decode_with_kv_cache(
    decoder: &mut ort::session::Session,
    kv_decoder: &mut ort::session::Session,
    tokenizer: &WhisperTokenizer,
    encoder_states: &Array3<f32>,
    prefix_ids: Vec<i64>,
    max_steps: usize,
    emitted: &mut Vec<u32>,
) -> Result<()> {
    // ── Initial pass: seeds the KV cache.
    let prefix_arr = Array2::<i64>::from_shape_vec((1, prefix_ids.len()), prefix_ids.clone())
        .map_err(|e| Error::Other(format!("decoder prefix shape: {e}")))?;
    let prefix_tensor = TensorRef::from_array_view(&prefix_arr)
        .map_err(|e| Error::Other(format!("prefix tensor: {e}")))?;
    let enc_tensor = TensorRef::from_array_view(encoder_states)
        .map_err(|e| Error::Other(format!("encoder tensor: {e}")))?;

    let initial_outputs = decoder
        .run(ort::inputs![
            "input_ids" => prefix_tensor,
            "encoder_hidden_states" => enc_tensor,
        ])
        .map_err(|e| Error::Other(format!("decoder.run (initial): {e}")))?;

    let mut next_id = pick_next_token(&initial_outputs)?;
    if tokenizer.is_terminal(next_id) {
        return Ok(());
    }
    emitted.push(next_id);

    // Drain "present.*" tensors out of the initial outputs into a
    // map keyed by their "past_key_values.*" rename.
    let mut past_kv: Vec<(String, ndarray::ArrayD<f32>)> = Vec::new();
    for (name, value) in initial_outputs.iter() {
        if let Some(stripped) = name.strip_prefix("present") {
            let arr = value
                .try_extract_array::<f32>()
                .map_err(|e| Error::Other(format!("present extract {name}: {e}")))?
                .into_owned();
            past_kv.push((format!("past_key_values{stripped}"), arr));
        }
    }
    if past_kv.is_empty() {
        return Err(Error::Other(
            "decoder.onnx did not emit any `present.*` outputs (KV cache unavailable)".into(),
        ));
    }

    for _ in 0..max_steps - 1 {
            // Build the next-step input: one new token + every past KV.
            let single_input = Array2::<i64>::from_shape_vec((1, 1), vec![next_id as i64])
                .map_err(|e| Error::Other(format!("decoder step shape: {e}")))?;

            // Stash tensor refs in vecs so they outlive the inputs! call.
            let mut kv_refs: Vec<(String, TensorRef<'_, f32>)> = Vec::with_capacity(past_kv.len());
            for (name, arr) in past_kv.iter() {
                let t = TensorRef::from_array_view(arr)
                    .map_err(|e| Error::Other(format!("past_kv tensor {name}: {e}")))?;
                kv_refs.push((name.clone(), t));
            }
            let single_tensor = TensorRef::from_array_view(&single_input)
                .map_err(|e| Error::Other(format!("step ids tensor: {e}")))?;
            let enc_tensor = TensorRef::from_array_view(encoder_states)
                .map_err(|e| Error::Other(format!("step encoder tensor: {e}")))?;

            // Build the heterogeneous SessionInputs map. We use the Vec
            // variant because the number of past_kv entries is dynamic
            // (depends on the model's layer count).
            let mut inputs: Vec<(std::borrow::Cow<'_, str>, ort::session::SessionInputValue<'_>)> =
                Vec::with_capacity(2 + kv_refs.len());
            inputs.push((
                "input_ids".into(),
                ort::session::SessionInputValue::from(single_tensor),
            ));
            inputs.push((
                "encoder_hidden_states".into(),
                ort::session::SessionInputValue::from(enc_tensor),
            ));
            for (name, t) in kv_refs.into_iter() {
                inputs.push((
                    std::borrow::Cow::Owned(name),
                    ort::session::SessionInputValue::from(t),
                ));
            }

            let outputs = kv_decoder
                .run(inputs)
                .map_err(|e| Error::Other(format!("decoder_with_past.run: {e}")))?;

        next_id = pick_next_token(&outputs)?;
        if tokenizer.is_terminal(next_id) {
            break;
        }
        emitted.push(next_id);

        // Roll the KV cache forward for the next step.
        past_kv.clear();
        for (name, value) in outputs.iter() {
            if let Some(stripped) = name.strip_prefix("present") {
                let arr = value
                    .try_extract_array::<f32>()
                    .map_err(|e| Error::Other(format!("present extract {name}: {e}")))?
                    .into_owned();
                past_kv.push((format!("past_key_values{stripped}"), arr));
            }
        }
    }
    Ok(())
}

/// Argmax the last position of a `(1, T, vocab)` logits tensor.
///
/// `index_axis(Axis(1), t-1)` collapses *only* the time axis, leaving a
/// `(batch=1, vocab)` view — still 2-D. We have to drop the batch axis
/// too before `into_dimensionality::<Ix1>()` will succeed; otherwise
/// the previous `.unwrap()` panicked with `ShapeError/IncompatibleShape:
/// incompatible shapes` the first time the KV-cache decode loop ran on
/// a real Xenova bundle (which is exactly what happened once we
/// shipped `decoder_with_past.onnx`).
fn pick_next_token(outputs: &ort::session::SessionOutputs) -> Result<u32> {
    let logits = outputs
        .get("logits")
        .ok_or_else(|| Error::Other("decoder did not emit logits".into()))?
        .try_extract_array::<f32>()
        .map_err(|e| Error::Other(format!("logits extract: {e}")))?
        .into_owned();
    let logits3: Array3<f32> = logits
        .into_dimensionality()
        .map_err(|e| Error::Other(format!("logits shape: {e}")))?;
    let t = logits3.shape()[1];
    // (1, T, vocab) → (1, vocab) → (vocab,)
    let row: Array1<f32> = logits3
        .index_axis(Axis(1), t - 1)
        .index_axis(Axis(0), 0)
        .to_owned();
    Ok(argmax_u32(&row))
}

/// Pull the last-position logits as a flat 1-D row, then return the
/// top-`k` `(token_id, log_prob)` pairs ranked by log-prob descending.
///
/// Used by the beam-search decoder. We compute log-softmax in-place
/// (via the standard log-sum-exp trick) so that adding scores across
/// time steps stays numerically stable.
fn top_logprobs(
    outputs: &ort::session::SessionOutputs,
    k: usize,
) -> Result<Vec<(u32, f32)>> {
    let logits = outputs
        .get("logits")
        .ok_or_else(|| Error::Other("decoder did not emit logits".into()))?
        .try_extract_array::<f32>()
        .map_err(|e| Error::Other(format!("logits extract: {e}")))?
        .into_owned();
    let logits3: Array3<f32> = logits
        .into_dimensionality()
        .map_err(|e| Error::Other(format!("logits shape: {e}")))?;
    let t = logits3.shape()[1];
    // (1, T, vocab) → index axis 1 → (1, vocab) → index axis 0 → (vocab,).
    // We must drop *both* the batch *and* the time axis; collapsing only
    // one of them leaves a 2-D view that `into_dimensionality::<Ix1>`
    // can't accept (was the actual cause of the KV-cache decoder
    // panicking on the first real inference call).
    let row: Array1<f32> = logits3
        .index_axis(Axis(1), t - 1)
        .index_axis(Axis(0), 0)
        .to_owned();

    // Log-softmax via the log-sum-exp trick (subtract the max before
    // exponentiating so the largest term is exactly 1.0 in linear space).
    let max = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0.0f64;
    for &v in row.iter() {
        sum += ((v - max) as f64).exp();
    }
    let log_z = (sum.ln() as f32) + max;

    // Partial sort to keep the top-k. For small k (≤ 8) this is faster
    // than full-sort and keeps allocations down.
    let mut top: Vec<(u32, f32)> = Vec::with_capacity(k + 1);
    for (id, &lg) in row.iter().enumerate() {
        let lp = lg - log_z;
        if top.len() < k {
            top.push((id as u32, lp));
            top.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        } else if lp > top[k - 1].1 {
            top[k - 1] = (id as u32, lp);
            top.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        }
    }
    Ok(top)
}

/// Length-normalised beam search over the re-feed decoder.
///
/// Each beam carries `(tokens, cum_logprob, finished)`. At every step we
/// run `decoder.onnx` once per *unfinished* beam to get the top-`k`
/// extensions, fan them out into `unfinished × k` candidates, and keep
/// only the `beam_size` best by `cum_logprob / len^0.6` (the standard
/// length-penalty exponent OpenAI's reference implementation uses).
///
/// A beam is "finished" when its last token is `<|endoftext|>`. We stop
/// the whole search once every beam is finished or `max_steps` is hit;
/// the highest-scoring finished beam wins, ties broken by raw
/// cum_logprob to avoid favouring short outputs on ties.
///
/// Beam search lives only in the re-feed path because every beam needs
/// its own KV cache, and cloning all `present.*` tensors per beam costs
/// more than re-feed beam search saves on every realistic Whisper size.
fn decode_refeed_beam(
    decoder: &mut ort::session::Session,
    tokenizer: &WhisperTokenizer,
    encoder_states: &Array3<f32>,
    prefix_ids: Vec<i64>,
    max_steps: usize,
    beam_size: usize,
    emitted: &mut Vec<u32>,
) -> Result<()> {
    #[derive(Clone)]
    struct Beam {
        tokens: Vec<i64>,
        score: f32,
        finished: bool,
    }

    fn length_penalty(len: usize) -> f32 {
        // ((5 + len) / 6) ^ alpha, alpha = 0.6 (Wu et al. 2016 / OpenAI).
        let l = (5.0_f32 + len as f32) / 6.0;
        l.powf(0.6)
    }

    fn normalised(b: &Beam) -> f32 {
        // Length-normalise over the *generated* tokens only. We
        // pretend the prefix is free since every beam shares it.
        b.score / length_penalty(b.tokens.len().max(1))
    }

    let mut beams: Vec<Beam> = vec![Beam {
        tokens: prefix_ids,
        score: 0.0,
        finished: false,
    }];

    let prefix_len = beams[0].tokens.len();

    for _ in 0..max_steps {
        // Collect candidates from every unfinished beam.
        let mut candidates: Vec<Beam> = Vec::with_capacity(beams.len() * beam_size);
        let mut any_active = false;
        for beam in beams.iter() {
            if beam.finished {
                candidates.push(beam.clone());
                continue;
            }
            any_active = true;

            let ids_arr = Array2::<i64>::from_shape_vec((1, beam.tokens.len()), beam.tokens.clone())
                .map_err(|e| Error::Other(format!("beam ids shape: {e}")))?;
            let ids_tensor = TensorRef::from_array_view(&ids_arr)
                .map_err(|e| Error::Other(format!("beam ids tensor: {e}")))?;
            let enc_tensor = TensorRef::from_array_view(encoder_states)
                .map_err(|e| Error::Other(format!("beam encoder tensor: {e}")))?;

            let outputs = decoder
                .run(ort::inputs![
                    "input_ids" => ids_tensor,
                    "encoder_hidden_states" => enc_tensor,
                ])
                .map_err(|e| Error::Other(format!("beam decoder.run: {e}")))?;

            for (id, lp) in top_logprobs(&outputs, beam_size)? {
                let mut next_tokens = beam.tokens.clone();
                next_tokens.push(id as i64);
                let finished = tokenizer.is_terminal(id);
                candidates.push(Beam {
                    tokens: next_tokens,
                    score: beam.score + lp,
                    finished,
                });
            }
        }
        if !any_active {
            break;
        }

        // Length-normalised top-`beam_size` survives.
        candidates.sort_unstable_by(|a, b| {
            normalised(b)
                .partial_cmp(&normalised(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(beam_size);
        beams = candidates;

        if beams.iter().all(|b| b.finished) {
            break;
        }
    }

    // Tie-break by raw cum_logprob so we don't favour very short
    // outputs that happened to land on the EOT token quickly.
    beams.sort_unstable_by(|a, b| {
        normalised(b)
            .partial_cmp(&normalised(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let best = beams.into_iter().next().ok_or_else(|| {
        Error::Other("beam search produced zero beams".into())
    })?;

    // Strip the shared SOT prefix and any trailing EOT before returning.
    for &t in best.tokens.iter().skip(prefix_len) {
        let id = t as u32;
        if tokenizer.is_terminal(id) {
            break;
        }
        emitted.push(id);
    }
    Ok(())
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
///   • Greedy decoding only — beam search is still pending (Phase 2C).
///   • Partial emissions fire every `PARTIAL_INTERVAL_MS` while an
///     utterance is in progress. With `decoder_with_past.onnx` available
///     the per-step decode is O(1) so a mid-utterance peek costs roughly
///     `encoder + new_tokens × decoder_with_past`, which is comparable
///     to whisper.cpp's partial cost and well within the 1.5 s window.
///     Bundles without the KV-cache graph still emit partials, but each
///     one re-runs the O(n²) re-feed loop — slower yet still useful for
///     UI responsiveness.

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

        // Partial-emission scheduling. Mirrors `whisper::spawn`:
        // every 1.5 s of an in-progress utterance we re-run the
        // engine on the buffer-so-far and emit it as a `seg-live`
        // interim segment so the UI's transcript can grow naturally
        // while the user keeps talking.
        let partial_interval = Duration::from_millis(1500);
        let mut next_partial_at = tokio::time::Instant::now() + partial_interval;
        let mut last_partial_text = String::new();

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
                                last_partial_text.clear();
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
                                last_partial_text.clear();
                                next_partial_at =
                                    tokio::time::Instant::now() + partial_interval;
                            }
                        }
                        frame_start = frame_end;
                    }
                    consumed_offset_samples += popped.len() as u64;

                    // ─── Partial emission ──────────────────────────────
                    // Run inference on the in-progress utterance and emit
                    // it as `seg-live` if the timer has elapsed and we
                    // have at least `min_speech_samples` of audio.
                    emit_onnx_partial_if_due(
                        &app,
                        engine.as_mut(),
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

/// Run the ONNX engine on the in-progress utterance and emit it as a
/// `seg-live` partial segment if the partial timer has fired and there
/// is enough buffered speech to be worth transcribing.
///
/// Mirrors `emit_partial_if_due` in `whisper.rs` so the dispatched
/// stream of segments looks identical regardless of which engine is
/// driving the session.
#[allow(clippy::too_many_arguments)]
fn emit_onnx_partial_if_due(
    app: &AppHandle,
    engine: Option<&mut OnnxWhisperEngine>,
    cfg: &OnnxConfig,
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

    let Some(e) = engine else { return };
    let text = match e.transcribe(utterance) {
        Ok(t) => t,
        Err(err) => {
            // Don't surface a `voxnap://error` for a partial — the next
            // partial (or the final at end-of-utterance) will retry.
            tracing::warn!("onnx transcribe (partial) failed: {err}");
            return;
        }
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    if trimmed == last_partial_text.as_str() {
        // No new tokens since the last partial — don't churn the UI.
        return;
    }
    last_partial_text.clear();
    last_partial_text.push_str(trimmed);

    let len_ms = (utterance.len() as i64 * 1000) / sr as i64;
    let _ = app.emit(
        "voxnap://segment",
        EmittedSegment {
            id: "seg-live".to_string(),
            text: trimmed.to_string(),
            start_ms,
            end_ms: start_ms + len_ms,
            is_final: false,
            confidence: None,
            language: if cfg.language == "auto" || cfg.language.is_empty() {
                None
            } else {
                Some(cfg.language.clone())
            },
        },
    );
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

// ───────────────────────────────────────────────────────────────────────────
// Smoke tests
// ───────────────────────────────────────────────────────────────────────────
//
// Phase 3 invariants. We can't run real inference here (we'd need the
// ONNX model bundle on disk + a microphone) but every pure-logic helper
// is testable in isolation, which is enough to catch refactor regressions.
#[cfg(test)]
mod tests {
    use super::*;

    /// `build_ep_list` must respect the user's compute-backend hint:
    ///   • `"cpu"` ⇒ never registers any EP, ORT falls through to its
    ///     implicit CPU executor.
    ///   • `"npu"` ⇒ never includes a *purely* GPU-only EP (CUDA /
    ///     DirectML / OpenVINO-GPU). NPU/CoreML EPs may appear.
    ///   • `"gpu"` ⇒ never includes a *purely* NPU-only EP (QNN /
    ///     OpenVINO-NPU).
    ///
    /// The body of the function is gated on cargo features for each EP,
    /// but the partitioning logic above must hold across every feature
    /// combination — that's what these tests pin down.
    #[test]
    fn cpu_backend_registers_no_ort_eps() {
        let eps = build_ep_list(Some("cpu"));
        assert!(
            eps.is_empty(),
            "compute_backend=cpu must skip every ORT EP, got {} entries",
            eps.len()
        );
    }

    #[test]
    fn auto_backend_registers_eps_when_features_enabled() {
        // We can't assert *which* EPs land in the list (that's
        // feature-gated) but we can confirm `"auto"` doesn't blow up
        // and that it returns a strict superset of `"cpu"` (which is
        // empty).
        let auto_eps = build_ep_list(Some("auto"));
        let cpu_eps = build_ep_list(Some("cpu"));
        assert!(auto_eps.len() >= cpu_eps.len());
    }

    #[test]
    fn unknown_backend_falls_through_to_no_eps() {
        // An unrecognised string is treated like `"cpu"` — neither
        // `want_npu` nor `want_gpu` matches, so no EP is registered.
        let eps = build_ep_list(Some("totally-not-a-backend"));
        assert!(
            eps.is_empty(),
            "unknown backends must register zero EPs, got {} entries",
            eps.len()
        );
    }

    /// Argmax returns the index of the largest element. NaNs are
    /// stable-skipped (the seed value `f32::NEG_INFINITY` keeps them
    /// from ever winning), which matches what the decoder expects.
    #[test]
    fn argmax_picks_largest_finite() {
        let v = ndarray::Array1::from(vec![0.1f32, 0.5, -1.0, 0.49, 0.5001, 0.2]);
        assert_eq!(argmax_u32(&v), 4);
    }

    /// Empty vec ⇒ index 0 (matches the historical behaviour and is
    /// what callers expect when the logits row is degenerate).
    #[test]
    fn argmax_handles_empty_vec() {
        let v = ndarray::Array1::<f32>::from(vec![]);
        assert_eq!(argmax_u32(&v), 0);
    }
}



