//! ONNX Runtime parallel inference pipeline.
//!
//! This module mirrors `whisper.rs` but routes inference through `ort`
//! (ONNX Runtime) instead of `whisper-rs`. It exists so Voxnap can offer
//! NPU/GPU acceleration on hardware that whisper.cpp doesn't cover yet:
//!
//! ┌─────────────────────────┬─────────────────────┬───────────────────┐
//! │ Hardware                │ Best ORT EP         │ Cargo feature     │
//! ├─────────────────────────┼─────────────────────┼───────────────────┤
//! │ Qualcomm Hexagon NPU    │ QNN                 │ ort-qnn           │
//! │ Intel AI Boost NPU      │ OpenVINO            │ ort-openvino      │
//! │ Intel iGPU / Arc GPU    │ OpenVINO / DirectML │ ort-openvino /    │
//! │                         │                     │ ort-directml      │
//! │ AMD Radeon GPU          │ DirectML            │ ort-directml      │
//! │ NVIDIA GPU              │ CUDA / DirectML     │ ort-cuda          │
//! │ Apple ANE / GPU         │ CoreML              │ ort-coreml        │
//! └─────────────────────────┴─────────────────────┴───────────────────┘
//!
//! Pipeline overview
//! -----------------
//! Whisper-as-ONNX has three sub-models that we load as separate
//! `ort::Session`s but execute as one logical pipeline:
//!
//!   1. **encoder** — `(mel: f32[1,80,3000]) → encoder_states f32[1,1500,d]`
//!   2. **decoder_initial** — first decoder pass with no past KV cache.
//!      Inputs: `encoder_states`, `tokens` (SOT prefix) → logits + KV.
//!   3. **decoder** — autoregressive step. Inputs: last token + past KV →
//!      logits + new KV. Looped until EOT or max len.
//!
//! Phase 1 of this module (this commit) provides:
//!   • the public surface (`spawn`, `OnnxConfig`) that mirrors `whisper::spawn`
//!   • EP registration glue
//!   • model file resolution
//!   • a working stub that loads the encoder session at startup
//!
//! Phase 2 (next commit) will add the actual encoder/decoder loop, BPE
//! tokenization, log-mel feature extraction, and KV-cache management.
//! The stub is intentionally functional enough to surface real ORT errors
//! to the UI ("encoder.onnx not found", "QNN EP failed to register on this
//! Hexagon variant", …) so we can validate the wiring on real NPU hardware
//! before the inference loop lands.

#![allow(dead_code)] // Phase 1: public surface only.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// Runtime configuration for the ONNX pipeline. Parallels `WhisperConfig`
/// in `whisper.rs` so the dispatcher in `commands.rs` can branch on
/// `compute_backend` and pick the right pipeline without converting types.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxConfig {
    /// Logical model id, e.g. `"base.q5_1.onnx"`. The on-disk layout is
    /// `<models-dir>/<modelId>/{encoder,decoder,decoder_initial}.onnx`.
    pub model_id: String,

    /// Language hint (`"auto"` or ISO-639-1). Same semantics as
    /// `WhisperConfig.language`.
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

    // ─── NPU candidates (highest priority) ─────────────────────────────
    #[cfg(feature = "ort-qnn")]
    if want_npu {
        out.push(ort::ep::QNN::default().build());
    }

    #[cfg(feature = "ort-openvino")]
    if want_npu {
        // OpenVINO with NPU device (`device_type = "NPU"`) targets the
        // Intel AI Boost NPU specifically; we add a separate entry for
        // GPU/AUTO below so the GPU-only path doesn't try to use NPU.
        out.push(ort::ep::OpenVINO::default().with_device_type("NPU").build());
    }

    #[cfg(feature = "ort-coreml")]
    if want_npu || want_gpu {
        out.push(ort::ep::CoreML::default().build());
    }

    // ─── GPU candidates ────────────────────────────────────────────────
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

/// Resolve the directory holding `{encoder,decoder,decoder_initial}.onnx`
/// for `cfg.model_id`. Search order mirrors `whisper::resolve_model_path`:
///   1. `cfg.model_dir` (must be a directory containing the bundle)
///   2. `<app-data>/models/onnx/<modelId>/`
///   3. `<resource-dir>/models/onnx/<modelId>/`
///   4. Dev fallbacks (walk up from exe + cwd)
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
// Engine handle (Phase 1: stub)
// ───────────────────────────────────────────────────────────────────────────

/// Loaded ORT sessions for one Whisper model.
///
/// Phase 1 only loads the encoder so we can validate EP registration on
/// real hardware. Phase 2 will add `decoder_initial` and `decoder` along
/// with the autoregressive loop.
pub struct OnnxWhisperEngine {
    pub encoder: ort::session::Session,
    pub model_dir: PathBuf,
    /// Which EP actually wired up. ORT tells us this through the registered
    /// providers list after `commit()`.
    pub active_ep: String,
}

impl OnnxWhisperEngine {
    /// Build an `OnnxWhisperEngine` with the user's preferred EP.
    pub fn load(app: &AppHandle, cfg: &OnnxConfig) -> Result<Self> {
        let dir = resolve_model_dir(app, cfg)?;
        let encoder_path = dir.join("encoder.onnx");

        tracing::info!(
            backend = cfg.compute_backend.as_deref().unwrap_or("auto"),
            model = %cfg.model_id,
            encoder = %encoder_path.display(),
            "loading ONNX encoder session"
        );

        // Initialize ort once per process. `init` is idempotent in
        // ort 2.0-rc.12 and will be a no-op on subsequent calls.
        // We deliberately don't call `commit_from_*` directly because we
        // want to capture the EP registration error path.
        let _ = ort::init().commit();

        let mut builder = ort::session::Session::builder()
            .map_err(|e| Error::Other(format!("ort builder: {e}")))?;

        if let Some(threads) = cfg.threads {
            builder = builder
                .with_intra_threads(threads as usize)
                .map_err(|e| Error::Other(format!("ort threads: {e}")))?;
        }

        // Register EPs in priority order. `with_execution_providers` is
        // the idiomatic ort 2.x API: it iterates the list, registers each
        // EP, and silently skips ones that fail (unless the EP was built
        // with `.error_on_failure()`). The first one that successfully
        // initializes is what the session actually uses.
        let eps = build_ep_list(cfg.compute_backend.as_deref());
        let active_ep = if eps.is_empty() {
            "cpu".to_string()
        } else {
            // Format the names *before* the move so we can log which EP
            // wins. ORT doesn't currently expose a "which one took" hook
            // post-commit; we report the first one in the list as a
            // heuristic. The graphify report calls this out.
            let names: Vec<String> = eps.iter().map(|ep| format!("{ep:?}")).collect();
            builder = builder
                .with_execution_providers(eps)
                .map_err(|e| Error::Other(format!("ort EP registration: {e}")))?;
            names.into_iter().next().unwrap_or_else(|| "cpu".into())
        };

        let encoder = builder
            .commit_from_file(&encoder_path)
            .map_err(|e| Error::Other(format!("load encoder.onnx: {e}")))?;

        Ok(Self {
            encoder,
            model_dir: dir,
            active_ep,
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry point — Phase 2 stub
// ───────────────────────────────────────────────────────────────────────────

/// Spawn the ONNX inference task. Mirrors `whisper::spawn`.
///
/// **Phase 1 stub:** this currently returns an error so the engine
/// dispatcher in `commands.rs` falls back to the whisper.cpp pipeline.
/// The real implementation lands in Phase 2 once the encoder/decoder loop,
/// log-mel feature extractor and BPE tokenizer are ported over.
///
/// We expose the function with the final signature today so the dispatcher
/// can be wired (and reviewed) before the heavy lifting lands.
pub fn spawn_stub(app: AppHandle, cfg: OnnxConfig) -> Result<OnnxWhisperEngine> {
    let engine = OnnxWhisperEngine::load(&app, &cfg)?;
    tracing::info!(
        active_ep = %engine.active_ep,
        model_dir = %engine.model_dir.display(),
        "ONNX engine ready (Phase 1 stub — inference loop pending)"
    );
    Ok(engine)
}
