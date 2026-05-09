//! Compute-accelerator detection.
//!
//! Voxnap can route inference to one of three buckets the UI cares about:
//!
//!   • `npu` — neural-processing-unit / dedicated AI accelerator
//!   • `gpu` — discrete or integrated GPU compute (Metal / CUDA / DirectML / Vulkan)
//!   • `cpu` — pure-CPU inference (always available)
//!
//! Two engines feed this list:
//!
//!  1. **whisper.cpp** (via `whisper-rs`) — uses CMake feature flags compiled
//!     into the binary. Backends: `coreml`, `metal`, `cuda`, `cpu`.
//!  2. **ONNX Runtime** (via `ort`) — uses Execution Providers (EPs)
//!     registered at compile time. Each EP can succeed or fail at *runtime*
//!     too: DirectML works only on Win10 1903+, CUDA EP needs the NVIDIA
//!     driver, OpenVINO/QNN need their vendor DLLs on PATH, etc. We probe
//!     each EP by trying to register it on a throwaway session-options
//!     handle; if that succeeds we mark the accelerator `available: true`.
//!
//! `detect()` reports every accelerator we can plausibly offer on this host
//! along with `available: bool` so the UI can show greyed-out rows with an
//! actionable hint ("Install OpenVINO Runtime to enable Intel NPU"). It
//! always appends a CPU entry at the bottom so the picker is never empty.
//!
//! Why runtime probing matters
//! ---------------------------
//! The previous version only checked `cfg!(feature = "cuda")` etc. That
//! lied to the user: a binary built with `--features ort-directml` on a
//! machine without WDDM 2.4 would still claim DirectML was available. We
//! now actually try to instantiate the EP and report the *real* error.
//!
//! NPU detection robustness
//! ------------------------
//! The previous "PowerShell only" Windows NPU probe silently returned
//! nothing on hosts where the driver hadn't classified the NPU under the
//! `ComputeAccelerator` setup class yet (some early Lunar Lake / Ryzen AI
//! drivers do this). We now run *three* parallel probes — PnP class +
//! generic friendly-name match + DXGI adapter scan via `dxdiag` — and
//! merge the results, so the UI lights up the NPU even if only one of
//! them sees it.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratorInfo {
    /// `"npu" | "gpu" | "cpu"` — matches `ComputeBackend` (minus `"auto"`)
    /// in `packages/core/src/types.ts`.
    pub id: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<&'static str>,
    /// Backend identifier. Matches `AcceleratorInfo.backend` documentation
    /// in `packages/core/src/types.ts`:
    ///   `"coreml" | "metal" | "cuda" | "vulkan" | "openvino" | "qnn" |
    ///    "directml" | "cpu"`
    pub backend: &'static str,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// Which inference pipeline owns this row:
    ///   `"whisper-cpp"` — `whisper-rs` / `WhisperCtx`
    ///   `"onnx"`        — `ort` / `OnnxWhisperEngine`
    ///   `"cpu"`         — always-on fallback
    /// The UI doesn't surface this field but it lets the engine dispatcher
    /// pick the right runtime for the user's `computeBackend` choice.
    pub provider: &'static str,
}

// ───────────────────────────────────────────────────────────────────────────
// whisper.cpp build-time feature flags
// ───────────────────────────────────────────────────────────────────────────

/// True iff the desktop binary was compiled with `whisper-rs`'s `coreml`
/// feature, which is the only way Apple's Neural Engine path lights up.
#[allow(dead_code)]
const HAS_COREML: bool = cfg!(feature = "coreml");
/// Apple GPU (Metal) backend.
#[allow(dead_code)]
const HAS_METAL: bool = cfg!(feature = "metal");
/// NVIDIA CUDA backend (whisper.cpp).
#[allow(dead_code)]
const HAS_CUDA: bool = cfg!(feature = "cuda");
/// CPU acceleration via OpenBLAS — informational only; we treat this as
/// "still CPU" for the UI's NPU/GPU/CPU bucketing.
#[allow(dead_code)]
const HAS_OPENBLAS: bool = cfg!(feature = "openblas");

// ───────────────────────────────────────────────────────────────────────────
// ORT execution-provider build-time flags
// ───────────────────────────────────────────────────────────────────────────
//
// IMPORTANT: We intentionally treat target-conditional `ort` features as
// equivalent to the matching cargo feature. The `[target.…]` blocks in
// `Cargo.toml` turn on `ort/directml` on Windows and `ort/coreml` on
// Apple platforms, which makes `ort::ep::DirectML` / `ort::ep::CoreML`
// available, but they do NOT flip our crate's `feature = "ort-directml"`
// cfg. If we kept the old `cfg!(feature = "ort-directml")` check we'd
// claim DirectML was "Not bundled" on every Windows build that didn't
// also pass `--features ort-directml` — which is exactly what was
// hiding NPUs from the UI on the default `pnpm dev:desktop` build.
#[allow(dead_code)]
const HAS_ORT_DIRECTML: bool =
    cfg!(any(feature = "ort-directml", target_os = "windows"));
#[allow(dead_code)]
const HAS_ORT_CUDA: bool = cfg!(feature = "ort-cuda");
#[allow(dead_code)]
const HAS_ORT_OPENVINO: bool = cfg!(feature = "ort-openvino");
#[allow(dead_code)]
const HAS_ORT_QNN: bool = cfg!(feature = "ort-qnn");
#[allow(dead_code)]
const HAS_ORT_COREML: bool = cfg!(any(
    feature = "ort-coreml",
    target_os = "macos",
    target_os = "ios"
));

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────

/// Detect compute accelerators offered by this host + binary.
///
/// The list is ordered most-preferred first, matching the order the engine
/// would pick under `computeBackend = "auto"` (NPU → GPU → CPU).
pub fn detect() -> Vec<AcceleratorInfo> {
    let mut out: Vec<AcceleratorInfo> = Vec::new();

    // ─── macOS / Apple Silicon ──────────────────────────────────────────
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        // Apple Neural Engine — preferred path.
        // We expose two providers: whisper.cpp's native CoreML encoder
        // (only when `--features coreml`) and the ORT CoreML EP (only when
        // `--features ort-coreml`). Whichever is available first wins.
        let (available, reason, provider) = if HAS_COREML {
            (true, None, "whisper-cpp")
        } else if HAS_ORT_COREML && ort_ep_probe::coreml_works().is_ok() {
            (true, None, "onnx")
        } else if HAS_ORT_COREML {
            let err = ort_ep_probe::coreml_works().err().unwrap_or_else(|| {
                "ORT CoreML EP linked but failed to initialize at runtime (likely a macOS version mismatch).".into()
            });
            (false, Some(err), "onnx")
        } else {
            (
                false,
                Some(
                    "Rebuild Voxnap with `cargo build --features coreml` (or `--features ort-coreml`) to enable Apple Neural Engine."
                        .into(),
                ),
                "whisper-cpp",
            )
        };
        out.push(AcceleratorInfo {
            id: "npu",
            label: "Apple Neural Engine".to_string(),
            vendor: Some("Apple"),
            backend: "coreml",
            available,
            unavailable_reason: reason,
            provider,
        });

        // Apple GPU (Metal) — whisper.cpp metal backend.
        let metal_reason = if !HAS_METAL {
            Some(
                "Rebuild Voxnap with `cargo build --features metal` to enable Apple GPU (Metal)."
                    .into(),
            )
        } else {
            None
        };
        out.push(AcceleratorInfo {
            id: "gpu",
            label: "Apple GPU (Metal)".to_string(),
            vendor: Some("Apple"),
            backend: "metal",
            available: HAS_METAL,
            unavailable_reason: metal_reason,
            provider: "whisper-cpp",
        });
    }

    // ─── macOS / Intel ──────────────────────────────────────────────────
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        // Intel Macs have no NPU; only Metal-capable GPU.
        let metal_reason = if !HAS_METAL {
            Some(
                "Rebuild Voxnap with `cargo build --features metal` to enable GPU acceleration."
                    .into(),
            )
        } else {
            None
        };
        out.push(AcceleratorInfo {
            id: "gpu",
            label: "Apple GPU (Metal)".to_string(),
            vendor: Some("Apple"),
            backend: "metal",
            available: HAS_METAL,
            unavailable_reason: metal_reason,
            provider: "whisper-cpp",
        });
    }

    // ─── Windows ────────────────────────────────────────────────────────
    #[cfg(target_os = "windows")]
    {
        // 1) Native NPU detection. We try every probe we have and merge
        //    the results so the UI lights up the NPU even when one of
        //    them comes back empty.
        if let Some(npu) = detect_windows_npu() {
            out.push(npu);
        } else {
            // No PnP NPU surfaced. Even so, if DirectML works we can
            // still drive an integrated NPU through D3D12 — DirectML on
            // Windows 11 24H2+ enumerates Copilot+ NPUs as compute
            // adapters. Don't report this as an NPU row though: we keep
            // it in the GPU row below and rely on the diagnostic report
            // for the user-facing "NPU not detected, but DirectML is
            // available" message.
            tracing::info!(
                "no NPU surfaced by Windows PnP; falling back to DirectML-only acceleration"
            );
        }

        // 2) NVIDIA GPU. Two providers can drive it:
        //    a) whisper.cpp's CUDA backend (cuBLAS-linked, fastest)
        //    b) ORT CUDA EP        (works for the ONNX pipeline)
        let (cuda_avail, cuda_reason, cuda_provider) = if HAS_CUDA {
            (true, None, "whisper-cpp")
        } else if HAS_ORT_CUDA && ort_ep_probe::cuda_works().is_ok() {
            (true, None, "onnx")
        } else if HAS_ORT_CUDA {
            let err = ort_ep_probe::cuda_works().err().unwrap_or_else(|| {
                "ORT CUDA EP linked but failed to initialize. Install the NVIDIA driver + CUDA Toolkit and try again.".into()
            });
            (false, Some(err), "onnx")
        } else {
            (
                false,
                Some(
                    "Rebuild Voxnap with `--features cuda` (whisper.cpp) or `--features ort-cuda` (ONNX) to enable NVIDIA GPU."
                        .into(),
                ),
                "whisper-cpp",
            )
        };
        out.push(AcceleratorInfo {
            id: "gpu",
            label: "NVIDIA GPU (CUDA)".to_string(),
            vendor: Some("NVIDIA"),
            backend: "cuda",
            available: cuda_avail,
            unavailable_reason: cuda_reason,
            provider: cuda_provider,
        });

        // 3) DirectML — vendor-agnostic GPU compute on Win10 1903+. Covers
        //    Intel Arc / iGPU, AMD Radeon, and integrated Adreno/Mali too.
        //    Sits *below* CUDA in the list because dedicated CUDA is faster
        //    on NVIDIA cards but DirectML is the universal fallback that
        //    does *something* on every modern Windows machine.
        let dml_probe = ort_ep_probe::directml_works();
        let (dml_avail, dml_reason) = if HAS_ORT_DIRECTML && dml_probe.is_ok() {
            (true, None)
        } else if HAS_ORT_DIRECTML {
            let err = dml_probe.err().unwrap_or_else(|| {
                "DirectML EP linked but D3D12 device creation failed. Update GPU drivers (need WDDM 2.4 / Win10 1903+).".into()
            });
            (false, Some(err))
        } else {
            (
                false,
                Some("Rebuild Voxnap with `--features ort-directml` to enable any-GPU acceleration via DirectX 12.".into()),
            )
        };
        out.push(AcceleratorInfo {
            id: "gpu",
            label: "GPU (DirectML)".to_string(),
            vendor: None,
            backend: "directml",
            available: dml_avail,
            unavailable_reason: dml_reason,
            provider: "onnx",
        });
    }

    // ─── Linux ──────────────────────────────────────────────────────────
    #[cfg(target_os = "linux")]
    {
        // NVIDIA GPU — same dual-provider story as Windows.
        let (cuda_avail, cuda_reason, cuda_provider) = if HAS_CUDA {
            (true, None, "whisper-cpp")
        } else if HAS_ORT_CUDA && ort_ep_probe::cuda_works().is_ok() {
            (true, None, "onnx")
        } else if HAS_ORT_CUDA {
            let err = ort_ep_probe::cuda_works().err().unwrap_or_else(|| {
                "ORT CUDA EP linked but failed to initialize. Check `nvidia-smi` and `ldconfig -p | grep cuda`.".into()
            });
            (false, Some(err), "onnx")
        } else {
            (
                false,
                Some("Rebuild Voxnap with `--features cuda` or `--features ort-cuda` to enable NVIDIA GPU.".into()),
                "whisper-cpp",
            )
        };
        out.push(AcceleratorInfo {
            id: "gpu",
            label: "NVIDIA GPU (CUDA)".to_string(),
            vendor: Some("NVIDIA"),
            backend: "cuda",
            available: cuda_avail,
            unavailable_reason: cuda_reason,
            provider: cuda_provider,
        });

        // OpenVINO covers Intel iGPU + Intel NPU on Linux too.
        let ov_probe = ort_ep_probe::openvino_works();
        let (ov_avail, ov_reason) = if HAS_ORT_OPENVINO && ov_probe.is_ok() {
            (true, None)
        } else if HAS_ORT_OPENVINO {
            let err = ov_probe.err().unwrap_or_else(|| {
                "OpenVINO EP linked but the runtime libraries weren't found. Install `intel-openvino-runtime`.".into()
            });
            (false, Some(err))
        } else {
            (
                false,
                Some("Rebuild Voxnap with `--features ort-openvino` to enable Intel NPU/iGPU acceleration.".into()),
            )
        };
        if HAS_ORT_OPENVINO || ov_avail {
            out.push(AcceleratorInfo {
                id: "npu",
                label: "Intel AI Boost (OpenVINO)".to_string(),
                vendor: Some("Intel"),
                backend: "openvino",
                available: ov_avail,
                unavailable_reason: ov_reason,
                provider: "onnx",
            });
        }
    }

    // ─── Mobile (iOS / Android) ─────────────────────────────────────────
    #[cfg(target_os = "ios")]
    {
        let (available, reason, provider) = if HAS_COREML {
            (true, None, "whisper-cpp")
        } else if HAS_ORT_COREML && ort_ep_probe::coreml_works().is_ok() {
            (true, None, "onnx")
        } else {
            let err = ort_ep_probe::coreml_works().err().unwrap_or_else(|| {
                "Rebuild the iOS bundle with `--features coreml` or `--features ort-coreml`.".into()
            });
            (false, Some(err), "whisper-cpp")
        };
        out.push(AcceleratorInfo {
            id: "npu",
            label: "Apple Neural Engine".to_string(),
            vendor: Some("Apple"),
            backend: "coreml",
            available,
            unavailable_reason: reason,
            provider,
        });
    }

    #[cfg(target_os = "android")]
    {
        // Qualcomm Hexagon NPU via QNN EP.
        let qnn_probe = ort_ep_probe::qnn_works();
        let (avail, reason) = if HAS_ORT_QNN && qnn_probe.is_ok() {
            (true, None)
        } else if HAS_ORT_QNN {
            let err = qnn_probe.err().unwrap_or_else(|| {
                "QNN EP linked but Hexagon DSP not reachable. Verify QNN backend libraries (libQnnHtp.so) are bundled."
                    .into()
            });
            (false, Some(err))
        } else {
            (
                false,
                Some(
                    "Rebuild the Android bundle with `--features ort-qnn` and bundle Qualcomm's QNN backend libraries to enable Hexagon NPU."
                        .into(),
                ),
            )
        };
        out.push(AcceleratorInfo {
            id: "npu",
            label: "Qualcomm Hexagon NPU".to_string(),
            vendor: Some("Qualcomm"),
            backend: "qnn",
            available: avail,
            unavailable_reason: reason,
            provider: "onnx",
        });
    }

    // ─── CPU is always last + always available ──────────────────────────
    out.push(AcceleratorInfo {
        id: "cpu",
        label: cpu_label(),
        vendor: None,
        backend: "cpu",
        available: true,
        unavailable_reason: None,
        provider: "cpu",
    });

    tracing::debug!(
        rows = out.len(),
        npu_available = out.iter().any(|r| r.id == "npu" && r.available),
        gpu_available = out.iter().any(|r| r.id == "gpu" && r.available),
        "accelerator detection finished"
    );

    out
}

fn cpu_label() -> String {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    if threads > 1 {
        format!("CPU ({threads} threads)")
    } else {
        "CPU".to_string()
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Diagnostic report
// ───────────────────────────────────────────────────────────────────────────

/// Verbose, user-readable summary of *why* a given accelerator (in
/// particular: the user's NPU) is or isn't lighting up.
///
/// The UI's Settings page exposes this through the
/// `voxnap_diagnose_accelerators` command and a "Diagnose NPU" button.
/// It's the difference between "Unavailable — ¯\\_(ツ)_/¯" and a real
/// actionable answer like:
///
/// > Compiled-in execution providers: DirectML  
/// > NPU detected by PnP: Intel(R) AI Boost  
/// > DirectML probe: ✓  
/// > QNN probe: skipped (rebuild with `--features ort-qnn`)  
/// > OpenVINO probe: skipped (rebuild with `--features ort-openvino`)
///
/// Returns one row per probed channel so the UI can render them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    /// Stable id we can match in the UI for icons (`compile-features`,
    /// `pnp-scan`, `directml-probe`, …).
    pub id: String,
    pub label: String,
    pub status: DiagnosticStatus,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticStatus {
    /// The probe succeeded: that EP / detection channel is working.
    Ok,
    /// The probe was skipped (typically: the matching cargo feature was
    /// off so we never even tried to load the EP).
    Skipped,
    /// The probe ran but failed; `detail` carries the underlying error.
    Failed,
    /// Informational only — neither pass nor fail.
    Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub platform: String,
    pub compiled_features: Vec<&'static str>,
    pub entries: Vec<DiagnosticEntry>,
}

/// Build a comprehensive diagnostic of every NPU/GPU detection channel.
pub fn diagnose() -> DiagnosticReport {
    let mut entries: Vec<DiagnosticEntry> = Vec::new();

    let compiled_features = compiled_features();
    entries.push(DiagnosticEntry {
        id: "compile-features".into(),
        label: "Compiled-in execution providers".into(),
        status: DiagnosticStatus::Info,
        detail: if compiled_features.is_empty() {
            "(none — pure CPU build)".into()
        } else {
            compiled_features.join(", ")
        },
    });

    // Per-EP probes — always run, even when the cargo feature is off, so
    // the user sees a "skipped: rebuild with --features ..." entry instead
    // of nothing.
    for (id, label, feat, probe) in [
        (
            "directml-probe",
            "DirectML",
            HAS_ORT_DIRECTML,
            ort_ep_probe::directml_works as fn() -> std::result::Result<(), String>,
        ),
        (
            "cuda-probe",
            "CUDA (ORT EP)",
            HAS_ORT_CUDA,
            ort_ep_probe::cuda_works,
        ),
        (
            "openvino-probe",
            "OpenVINO (Intel iGPU/NPU)",
            HAS_ORT_OPENVINO,
            ort_ep_probe::openvino_works,
        ),
        (
            "qnn-probe",
            "QNN (Qualcomm Hexagon NPU)",
            HAS_ORT_QNN,
            ort_ep_probe::qnn_works,
        ),
        (
            "coreml-probe",
            "CoreML (Apple ANE)",
            HAS_ORT_COREML,
            ort_ep_probe::coreml_works,
        ),
    ] {
        if !feat {
            entries.push(DiagnosticEntry {
                id: id.into(),
                label: label.into(),
                status: DiagnosticStatus::Skipped,
                detail: format!(
                    "Not compiled in. Rebuild Voxnap with the matching `--features {}` flag.",
                    match id {
                        "directml-probe" => "ort-directml",
                        "cuda-probe" => "ort-cuda",
                        "openvino-probe" => "ort-openvino",
                        "qnn-probe" => "ort-qnn",
                        "coreml-probe" => "ort-coreml",
                        _ => "ort-all",
                    }
                ),
            });
            continue;
        }
        match probe() {
            Ok(()) => entries.push(DiagnosticEntry {
                id: id.into(),
                label: label.into(),
                status: DiagnosticStatus::Ok,
                detail: "Execution provider initialised successfully.".into(),
            }),
            Err(e) => entries.push(DiagnosticEntry {
                id: id.into(),
                label: label.into(),
                status: DiagnosticStatus::Failed,
                detail: e,
            }),
        }
    }

    // PnP / OS-level NPU sniffing.
    #[cfg(target_os = "windows")]
    {
        let scan = windows_npu_scan();
        if scan.devices.is_empty() {
            entries.push(DiagnosticEntry {
                id: "pnp-scan".into(),
                label: "Windows NPU PnP scan".into(),
                status: DiagnosticStatus::Failed,
                detail: scan.diagnostic.unwrap_or_else(|| {
                    "No device matched the ComputeAccelerator class or the friendly-name fallback. \
                     Check that the NPU driver is installed (Device Manager → \"Neural processors\") \
                     and that Windows is up to date (24H2+ exposes Copilot+ NPUs by default)."
                        .into()
                }),
            });
        } else {
            for d in &scan.devices {
                entries.push(DiagnosticEntry {
                    id: "pnp-scan".into(),
                    label: format!("PnP device: {}", d.name),
                    status: DiagnosticStatus::Ok,
                    detail: format!(
                        "vendor={} (source: {})",
                        if d.manufacturer.is_empty() {
                            "(unknown)"
                        } else {
                            &d.manufacturer
                        },
                        d.source,
                    ),
                });
            }
        }
    }

    DiagnosticReport {
        platform: format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
        compiled_features,
        entries,
    }
}

fn compiled_features() -> Vec<&'static str> {
    let mut feats: Vec<&'static str> = Vec::new();
    if HAS_COREML {
        feats.push("coreml (whisper.cpp)");
    }
    if HAS_METAL {
        feats.push("metal (whisper.cpp)");
    }
    if HAS_CUDA {
        feats.push("cuda (whisper.cpp)");
    }
    if HAS_ORT_DIRECTML {
        feats.push("ort-directml");
    }
    if HAS_ORT_CUDA {
        feats.push("ort-cuda");
    }
    if HAS_ORT_OPENVINO {
        feats.push("ort-openvino");
    }
    if HAS_ORT_QNN {
        feats.push("ort-qnn");
    }
    if HAS_ORT_COREML {
        feats.push("ort-coreml");
    }
    feats
}

// ───────────────────────────────────────────────────────────────────────────
// ORT execution-provider runtime probes
// ───────────────────────────────────────────────────────────────────────────
//
// Each probe tries to register the EP on a throwaway `SessionBuilder`. We
// return `Result<(), String>` so the *exact* ORT error reaches the UI —
// previously these returned `bool` and the UI was left guessing why a
// DLL load failed.
//
// All probe fns are no-ops returning `Err("not compiled in")` when the
// matching cargo feature is off.
mod ort_ep_probe {
    #[allow(unused_imports)]
    use ort::ep::ExecutionProvider;

    /// Run `register` on a throwaway SessionBuilder and report the first
    /// error verbatim.
    #[allow(dead_code)]
    fn try_register<E: ExecutionProvider>(ep: &E) -> std::result::Result<(), String> {
        let mut builder = ort::session::Session::builder()
            .map_err(|e| format!("ort::Session::builder() failed: {e}"))?;
        ep.register(&mut builder)
            .map_err(|e| format!("EP register failed: {e}"))?;
        Ok(())
    }

    #[cfg(any(feature = "ort-directml", target_os = "windows"))]
    pub fn directml_works() -> std::result::Result<(), String> {
        try_register(&ort::ep::DirectML::default().with_device_id(0))
    }
    #[cfg(not(any(feature = "ort-directml", target_os = "windows")))]
    pub fn directml_works() -> std::result::Result<(), String> {
        Err("ort-directml not compiled in".into())
    }

    #[cfg(feature = "ort-cuda")]
    pub fn cuda_works() -> std::result::Result<(), String> {
        try_register(&ort::ep::CUDA::default().with_device_id(0))
    }
    #[cfg(not(feature = "ort-cuda"))]
    pub fn cuda_works() -> std::result::Result<(), String> {
        Err("ort-cuda not compiled in".into())
    }

    #[cfg(feature = "ort-openvino")]
    pub fn openvino_works() -> std::result::Result<(), String> {
        try_register(&ort::ep::OpenVINO::default().with_device_type("AUTO"))
    }
    #[cfg(not(feature = "ort-openvino"))]
    pub fn openvino_works() -> std::result::Result<(), String> {
        Err("ort-openvino not compiled in".into())
    }

    #[cfg(feature = "ort-qnn")]
    pub fn qnn_works() -> std::result::Result<(), String> {
        // We don't pass a backend_path here — without one, QNN looks up the
        // default `QnnHtp.dll` (Windows) / `libQnnHtp.so` (Android) on the
        // dynamic-library search path. The probe still fails if QNN can't
        // talk to the Hexagon DSP, which is what we want to surface.
        try_register(&ort::ep::QNN::default())
    }
    #[cfg(not(feature = "ort-qnn"))]
    pub fn qnn_works() -> std::result::Result<(), String> {
        Err("ort-qnn not compiled in".into())
    }

    #[cfg(any(feature = "ort-coreml", target_os = "macos", target_os = "ios"))]
    pub fn coreml_works() -> std::result::Result<(), String> {
        try_register(&ort::ep::CoreML::default())
    }
    #[cfg(not(any(feature = "ort-coreml", target_os = "macos", target_os = "ios")))]
    pub fn coreml_works() -> std::result::Result<(), String> {
        Err("ort-coreml not compiled in".into())
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Windows NPU probe (PnP)
// ───────────────────────────────────────────────────────────────────────────

/// Best-effort Windows NPU probe.
///
/// Windows 11 24H2+ exposes Copilot+ NPUs (Qualcomm Hexagon, Intel AI Boost,
/// AMD XDNA) through PnP under the dedicated `ComputeAccelerator` setup
/// class. We previously shelled out to `wmic`, but Microsoft removed
/// `wmic.exe` from Windows 11 24H2, which silently broke detection on
/// exactly the Copilot+ PCs we care about. PowerShell's `Get-PnpDevice` is
/// present on every supported Windows host and exposes the same data.
///
/// We now run a *stack* of detection passes inside one PowerShell call
/// and merge the output, so the NPU is found even if the driver hasn't
/// classified it under `ComputeAccelerator` yet.
///
/// Once we know an NPU is present we pick the best ORT EP that targets it:
///   • Qualcomm  → QNN EP   (`ort-qnn`)
///   • Intel     → OpenVINO (`ort-openvino`)
///   • AMD XDNA  → no first-class ORT EP yet — we surface it as detected
///     but unavailable, matching the UI's existing convention.
#[cfg(target_os = "windows")]
#[derive(Debug, Default, Clone)]
struct WindowsNpu {
    name: String,
    manufacturer: String,
    /// PnP setup class — used by the Rust-side validator to drop any row
    /// that PowerShell let through but obviously isn't a compute device.
    /// Currently consumed only at scan-construction time (the deny-list
    /// check happens before this field is stored). We still keep it on
    /// the struct so future diagnostic output can surface "device X was
    /// kept under class Y" without re-shelling to PowerShell.
    #[allow(dead_code)]
    class: String,

    /// Which probe surfaced this entry — useful in the diagnostic report.
    source: String,
}

/// Setup-class names that categorically can't be compute accelerators.
/// PowerShell already filters these out in pass 2, but we apply the same
/// guard in Rust as a belt-and-braces safety net (e.g. for rows from
/// pass 1 / `ComputeAccelerator` where a vendor mis-classifies a non-NPU
/// device into the class).
#[cfg(target_os = "windows")]
const NON_ACCELERATOR_CLASSES: &[&str] = &[
    "MEDIA",
    "AudioEndpoint",
    "Bluetooth",
    "Camera",
    "Image",
    "HIDClass",
    "USB",
    "USBDevice",
    "Net",
    "PrintQueue",
    "Printer",
    "Modem",
    "Monitor",
    "Keyboard",
    "Mouse",
    "WPD",
    "SmartCardReader",
    "Sensor",
    "Biometric",
];

/// Rust-side validator that double-checks a row's name with the same
/// word-boundary keyword set the PowerShell pass uses. Cheap, stringly-
/// typed, and means even if a `ComputeAccelerator`-classed device shows
/// up with a totally generic name (or a future PowerShell regression
/// strips the `\b` anchors) we still don't promote a "CABLE Input" to
/// an NPU.
#[cfg(target_os = "windows")]
fn looks_like_real_npu(name: &str) -> bool {
    // Tokenise on anything that isn't `[A-Za-z0-9+]` so e.g.
    // "AMD Ryzen AI" → ["AMD","Ryzen","AI"], and "iNPUt" stays as
    // a single token (which we then case-insensitively compare).
    let tokens: Vec<String> = name
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '+'))
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_uppercase())
        .collect();
    if tokens.is_empty() {
        return false;
    }
    // Exact-token matches — these are the unambiguous NPU markers.
    let single_token_hits = ["NPU", "HEXAGON", "XDNA", "OPENVINO"];
    if tokens.iter().any(|t| single_token_hits.contains(&t.as_str())) {
        return true;
    }
    // Bi-gram matches: "AI Boost", "Neural Processor", "Ryzen AI",
    // "Neural Engine", "Copilot+ NPU".
    for window in tokens.windows(2) {
        let bigram = (window[0].as_str(), window[1].as_str());
        match bigram {
            ("AI", "BOOST") => return true,
            ("NEURAL", "PROCESSOR") | ("NEURAL", "PROCESSORS") => return true,
            ("NEURAL", "ENGINE") => return true,
            ("RYZEN", "AI") => return true,
            ("COPILOT+", "NPU") => return true,
            _ => {}
        }
    }
    false
}


#[cfg(target_os = "windows")]
#[derive(Debug, Default, Clone)]
struct WindowsNpuScan {
    devices: Vec<WindowsNpu>,
    /// Set when *all* probes failed; carries the stderr of the last one
    /// for the diagnostic report.
    diagnostic: Option<String>,
}

#[cfg(target_os = "windows")]
fn windows_npu_scan() -> WindowsNpuScan {
    use std::process::Command;

    // We run all three probes in one PowerShell invocation so the
    // 250-300 ms cold-start cost is amortised. Each probe prefixes its
    // output with a tag (`PNP|`, `NAME|`, `DXG|`) so we can attribute
    // the source.
    // ---------------------------------------------------------------
    // The regex matches MUST be anchored with `\b` word boundaries.
    // Without them the bare `NPU` token matches the substring `nPU`
    // inside `iNPUt` (PowerShell `-match` is case-insensitive), so
    // every present-only device with "Input" in its FriendlyName —
    // most notoriously "CABLE Input (VB-Audio Virtual Cable)" —
    // would get misclassified as an NPU. Same reasoning for `Neural`
    // matching `Neural*Net*` driver strings, etc.
    //
    // We also exclude PnP classes that physically can't be a compute
    // accelerator (audio endpoints, bluetooth, USB hubs…). This is a
    // belt-and-braces guard so a future driver that puts something
    // suspicious in its FriendlyName still can't get promoted to
    // "NPU" if the device class says it's a microphone.
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'

# Classes that are categorically NOT compute accelerators. We bail
# out of any PnP candidate that lives under one of these — keeps
# audio/network/USB devices from being promoted by the fuzzy
# friendly-name fallback below.
$excludedClasses = @(
    'MEDIA', 'AudioEndpoint', 'Bluetooth', 'Camera', 'Image',
    'HIDClass', 'USB', 'USBDevice', 'Net', 'PrintQueue',
    'Printer', 'Modem', 'Monitor', 'Keyboard', 'Mouse',
    'WPD', 'SmartCardReader', 'Sensor', 'Biometric'
)

# Pass 1 — PnP ComputeAccelerator class. This is the canonical surface
# Microsoft documents for Copilot+ NPUs.
$pnp = Get-PnpDevice -PresentOnly -Class ComputeAccelerator
foreach ($x in $pnp) {
    $mfg = (Get-PnpDeviceProperty -InstanceId $x.InstanceId -KeyName 'DEVPKEY_Device_Manufacturer').Data
    Write-Output ("PNP|{0}|{1}|{2}" -f $x.FriendlyName, $mfg, $x.Class)
}

# Pass 2 — friendly-name fallback. Some early Lunar Lake / Hawk Point /
# Strix Halo drivers list the NPU under the System or "Neural processors"
# class instead of ComputeAccelerator, so we widen the net — but only
# across plausible classes and with WORD-BOUNDARY anchored regex so
# we never accidentally promote "CABLE Input" because it contains
# the substring "NPU".
$names = Get-PnpDevice -PresentOnly | Where-Object {
    ($excludedClasses -notcontains $_.Class) -and
    ($_.FriendlyName -match '\bNPU\b|\bNeural\s+Processor(s)?\b|\bAI\s+Boost\b|\bHexagon\b|\bXDNA\b|\bRyzen\s+AI\b|\bCopilot\+\s*NPU\b')
}
foreach ($x in $names) {
    $mfg = (Get-PnpDeviceProperty -InstanceId $x.InstanceId -KeyName 'DEVPKEY_Device_Manufacturer').Data
    Write-Output ("NAME|{0}|{1}|{2}" -f $x.FriendlyName, $mfg, $x.Class)
}

# Pass 3 — DXGI adapter scan via CIM. Windows 11 24H2 enumerates the NPU
# as a D3D12 adapter, which means it has a `Win32_VideoController` row.
# Same word-boundary tightening as Pass 2.
$gpu = Get-CimInstance Win32_VideoController | Where-Object {
    $_.Name -match '\bNPU\b|\bNeural\s+(Processor|Engine)\b|\bAI\s+Boost\b|\bHexagon\b|\bXDNA\b|\bRyzen\s+AI\b'
}
foreach ($x in $gpu) {
    Write-Output ("DXG|{0}|{1}|VideoController" -f $x.Name, $x.AdapterCompatibility)
}
"#;

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return WindowsNpuScan {
                devices: vec![],
                diagnostic: Some(format!("powershell.exe failed to launch: {e}")),
            };
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return WindowsNpuScan {
            devices: vec![],
            diagnostic: Some(format!(
                "powershell exited with status {}: {}",
                output.status, stderr
            )),
        };
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut devices: Vec<WindowsNpu> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Each line is `SOURCE|FRIENDLY_NAME|MANUFACTURER|CLASS`. The
        // class field is new (was missing in the pre-fix version) — it
        // backstops PowerShell's `-notcontains $excludedClasses` check
        // so a future regression in the script can't bypass us.
        let mut parts = line.splitn(4, '|');
        let source = parts.next().unwrap_or("").to_string();
        let name = parts.next().unwrap_or("").trim().to_string();
        let manufacturer = parts.next().unwrap_or("").trim().to_string();
        let class = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        // Belt-and-braces #1: drop anything whose PnP class is on the
        // "categorically not an accelerator" list. This catches the
        // CABLE Input → "MEDIA" / "AudioEndpoint" case even if the
        // PowerShell pass somehow lets it through.
        if NON_ACCELERATOR_CLASSES
            .iter()
            .any(|c| c.eq_ignore_ascii_case(&class))
        {
            tracing::debug!(
                name = %name,
                class = %class,
                "dropping PnP candidate: class is in NON_ACCELERATOR_CLASSES",
            );
            continue;
        }
        // Belt-and-braces #2: require the friendly name to actually
        // look like an NPU under the same word-boundary rules the
        // PowerShell regex uses.
        if !looks_like_real_npu(&name) {
            tracing::debug!(
                name = %name,
                "dropping PnP candidate: friendly name doesn't match NPU keyword set",
            );
            continue;
        }
        // De-dupe across the three probes — same device may surface in
        // PNP and NAME at the same time.
        if devices.iter().any(|d| d.name.eq_ignore_ascii_case(&name)) {
            continue;
        }
        devices.push(WindowsNpu {
            name,
            manufacturer,
            class,
            source,
        });
    }

    WindowsNpuScan {
        devices,
        diagnostic: None,
    }
}


#[cfg(target_os = "windows")]
fn detect_windows_npu() -> Option<AcceleratorInfo> {
    let scan = windows_npu_scan();
    if scan.devices.is_empty() {
        if let Some(d) = &scan.diagnostic {
            tracing::warn!("Windows NPU scan failed: {d}");
        }
        return None;
    }
    let first = scan.devices.into_iter().next()?;
    let WindowsNpu {
        name, manufacturer, ..
    } = first;

    // Classify vendor → backend → ort EP probe.
    enum Vendor {
        Qualcomm,
        Intel,
        Amd,
        Unknown,
    }
    let vendor_kind = match manufacturer.as_str() {
        m if m.contains("Qualcomm") => Vendor::Qualcomm,
        m if m.contains("Intel") => Vendor::Intel,
        m if m.contains("AMD") || m.contains("Advanced Micro") => Vendor::Amd,
        _ => match name.as_str() {
            n if n.contains("Hexagon") => Vendor::Qualcomm,
            n if n.contains("AI Boost") => Vendor::Intel,
            n if n.contains("XDNA") || n.contains("Ryzen AI") => Vendor::Amd,
            _ => Vendor::Unknown,
        },
    };

    let (vendor, backend, available, reason, provider): (
        Option<&'static str>,
        &'static str,
        bool,
        Option<String>,
        &'static str,
    ) = match vendor_kind {
        Vendor::Qualcomm => {
            let probe = ort_ep_probe::qnn_works();
            if HAS_ORT_QNN && probe.is_ok() {
                (Some("Qualcomm"), "qnn", true, None, "onnx")
            } else if HAS_ORT_QNN {
                let err = probe.err().unwrap_or_else(|| {
                    "QNN backend DLLs (QnnHtp.dll) couldn't be loaded.".into()
                });
                (
                    Some("Qualcomm"),
                    "qnn",
                    false,
                    Some(format!("Hexagon NPU detected. {err}")),
                    "onnx",
                )
            } else {
                // QNN isn't compiled in. On Windows 11 24H2+ DirectML can
                // still drive the Hexagon NPU through D3D12 — which is
                // exactly the case where the default Voxnap build now
                // works out of the box, because we auto-enabled DirectML
                // in `Cargo.toml` for `target_os = "windows"`.
                let dml = ort_ep_probe::directml_works();
                if HAS_ORT_DIRECTML && dml.is_ok() {
                    (
                        Some("Qualcomm"),
                        "directml",
                        true,
                        None,
                        "onnx",
                    )
                } else {
                    (
                        Some("Qualcomm"),
                        "qnn",
                        false,
                        Some(
                            "Hexagon NPU detected. Rebuild Voxnap with `--features ort-qnn` and bundle the Qualcomm QNN runtime to enable native NPU inference."
                                .into(),
                        ),
                        "onnx",
                    )
                }
            }
        }
        Vendor::Intel => {
            let ov = ort_ep_probe::openvino_works();
            if HAS_ORT_OPENVINO && ov.is_ok() {
                (Some("Intel"), "openvino", true, None, "onnx")
            } else {
                let dml = ort_ep_probe::directml_works();
                if HAS_ORT_DIRECTML && dml.is_ok() {
                    // DirectML is the universal Windows fallback. On
                    // Lunar Lake the AI Boost NPU is exposed as a D3D12
                    // compute device too, so DirectML drives it natively.
                    (Some("Intel"), "directml", true, None, "onnx")
                } else if HAS_ORT_OPENVINO {
                    let err = ov.err().unwrap_or_else(|| {
                        "OpenVINO runtime libraries (openvino.dll) couldn't be found.".into()
                    });
                    (
                        Some("Intel"),
                        "openvino",
                        false,
                        Some(format!("Intel AI Boost NPU detected. {err}")),
                        "onnx",
                    )
                } else {
                    (
                        Some("Intel"),
                        "openvino",
                        false,
                        Some(
                            "Intel AI Boost NPU detected. Rebuild Voxnap with `--features ort-openvino` and install the OpenVINO runtime for native NPU inference."
                                .into(),
                        ),
                        "onnx",
                    )
                }
            }
        }
        Vendor::Amd => {
            let dml = ort_ep_probe::directml_works();
            if HAS_ORT_DIRECTML && dml.is_ok() {
                // AMD XDNA / Ryzen AI is reachable through DirectML on
                // recent drivers. No first-class ONNX EP exists yet, but
                // DirectML routes ops to the NPU for supported ops.
                (Some("AMD"), "directml", true, None, "onnx")
            } else {
                (
                    Some("AMD"),
                    "xdna",
                    false,
                    Some(
                        "AMD Ryzen AI / XDNA NPU detected. No production-ready ONNX Runtime EP exists for XDNA yet. \
                         Build Voxnap with `--features ort-directml` to drive it through DirectX 12."
                            .into(),
                    ),
                    "onnx",
                )
            }
        }
        Vendor::Unknown => {
            let dml = ort_ep_probe::directml_works();
            if HAS_ORT_DIRECTML && dml.is_ok() {
                (None, "directml", true, None, "onnx")
            } else {
                (
                    None,
                    "npu",
                    false,
                    Some(
                        "NPU detected but Voxnap can't pick a matching backend without vendor information. \
                         Rebuild with `--features ort-directml` to fall back to a generic D3D12 path."
                            .into(),
                    ),
                    "onnx",
                )
            }
        }
    };

    Some(AcceleratorInfo {
        id: "npu",
        label: name,
        vendor,
        backend,
        available,
        unavailable_reason: reason,
        provider,
    })
}

// ───────────────────────────────────────────────────────────────────────────
// Smoke tests
// ───────────────────────────────────────────────────────────────────────────
//
// Phase 3 keeps detection invariants honest across the whole build matrix:
//
//  • CPU is always the *last* row and always `available`.
//  • Every NPU/GPU row carries the bucket id the JS side keys on
//    (`npu` / `gpu`), the matching `provider` ("whisper-cpp" or
//    "onnx"), and either an `unavailable_reason` or `available = true`.
//  • The runtime EP probes never panic — even on hosts where the EP
//    library is missing they should return `Err`, not abort.
//
// These unit tests are dirt-cheap (single `detect()` call + invariant
// checks) which means we can run them on every CI matrix entry,
// including the Voxnap-Universal artifact, as a per-EP smoke test.
#[cfg(test)]
mod tests {
    use super::*;

    /// `detect()` always returns a non-empty list and CPU is the
    /// guaranteed-available fallback at the bottom.
    #[test]
    fn cpu_row_is_always_present_and_available() {
        let rows = detect();
        assert!(!rows.is_empty(), "detect() must always return at least CPU");
        let cpu = rows.last().expect("non-empty above");
        assert_eq!(cpu.id, "cpu", "last row must be the CPU fallback");
        assert!(cpu.available, "CPU must always be available");
        assert_eq!(cpu.backend, "cpu");
        assert_eq!(cpu.provider, "cpu");
        assert!(cpu.unavailable_reason.is_none());
    }

    /// Every reported row uses one of the documented bucket ids.
    #[test]
    fn bucket_ids_are_well_known() {
        for row in detect() {
            assert!(
                matches!(row.id, "npu" | "gpu" | "cpu"),
                "unexpected bucket id `{}` for {}",
                row.id,
                row.label,
            );
        }
    }

    /// Every unavailable row should also carry an actionable hint.
    #[test]
    fn unavailable_rows_have_a_reason() {
        for row in detect() {
            if row.available {
                continue;
            }
            assert!(
                row.unavailable_reason.is_some(),
                "row `{}` is unavailable but carries no reason",
                row.label,
            );
        }
    }

    /// Every available `npu`/`gpu` row must declare a non-CPU provider.
    #[test]
    fn available_accelerator_rows_dispatch_to_a_real_pipeline() {
        for row in detect() {
            if row.id == "cpu" || !row.available {
                continue;
            }
            assert!(
                matches!(row.provider, "whisper-cpp" | "onnx"),
                "available row `{}` must dispatch to whisper-cpp or onnx, got {}",
                row.label,
                row.provider,
            );
        }
    }

    /// EP probes must never panic — even on hosts where the underlying
    /// runtime library is missing, the helper returns `Err`.
    #[test]
    fn ort_ep_probes_never_panic() {
        let _ = ort_ep_probe::directml_works();
        let _ = ort_ep_probe::cuda_works();
        let _ = ort_ep_probe::openvino_works();
        let _ = ort_ep_probe::qnn_works();
        let _ = ort_ep_probe::coreml_works();
    }

    /// `diagnose()` always emits the platform string + at least one
    /// EP entry so the UI always has something to show.
    #[test]
    fn diagnose_returns_a_useful_report() {
        let report = diagnose();
        assert!(!report.platform.is_empty());
        assert!(
            !report.entries.is_empty(),
            "diagnostic report should never be empty"
        );
        // The first entry is always the compile-features summary.
        assert_eq!(report.entries[0].id, "compile-features");
    }

    // ───────────────────────────────────────────────────────────────
    // Windows NPU friendly-name validator regression tests
    // ───────────────────────────────────────────────────────────────
    //
    // The original "NPU|Neural Processor|…" PowerShell regex didn't
    // anchor with `\b` and matched substrings, so any FriendlyName
    // containing the letters "nPU" — most notoriously the VB-Audio
    // virtual sound card "CABLE Input (VB-Audio Virtual Cable)" —
    // got promoted to an NPU. These tests pin the new behaviour.

    #[cfg(target_os = "windows")]
    #[test]
    fn validator_rejects_audio_devices_with_npu_substring() {
        // The exact string that triggered the original bug.
        assert!(
            !looks_like_real_npu("CABLE Input (VB-Audio Virtual Cable)"),
            "CABLE Input must not be promoted to NPU just because `iNPUt` contains the substring `NPU`",
        );
        assert!(!looks_like_real_npu("CABLE Output (VB-Audio Virtual Cable)"));
        assert!(!looks_like_real_npu("Microphone (Realtek(R) Audio)"));
        assert!(!looks_like_real_npu("Headphones"));
        // Devices whose name happens to contain a fragment of an NPU
        // keyword but not as a standalone token.
        assert!(!looks_like_real_npu("NeuralNet Trainer Pro 9000"));
        assert!(!looks_like_real_npu("Neuralink Interface"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn validator_accepts_real_npu_friendly_names() {
        // The actual marketing names Windows surfaces for shipping NPUs.
        assert!(looks_like_real_npu("Intel(R) AI Boost"));
        assert!(looks_like_real_npu("Qualcomm(R) Hexagon(TM) NPU"));
        assert!(looks_like_real_npu("AMD Ryzen AI"));
        assert!(looks_like_real_npu("AMD XDNA Neural Processing Unit"));
        assert!(looks_like_real_npu("NPU"));
        assert!(looks_like_real_npu("Neural Processor"));
        assert!(looks_like_real_npu("Neural Processors"));
        assert!(looks_like_real_npu("Apple Neural Engine"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn validator_handles_empty_and_punctuation_only_names() {
        assert!(!looks_like_real_npu(""));
        assert!(!looks_like_real_npu("   "));
        assert!(!looks_like_real_npu("--"));
        assert!(!looks_like_real_npu("()"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn excluded_classes_list_covers_audio_endpoints() {
        // The two classes that the CABLE Input device is most likely to
        // surface under (depending on how VB-Audio installed the
        // driver) — both must be on the deny-list.
        assert!(NON_ACCELERATOR_CLASSES
            .iter()
            .any(|c| c.eq_ignore_ascii_case("MEDIA")));
        assert!(NON_ACCELERATOR_CLASSES
            .iter()
            .any(|c| c.eq_ignore_ascii_case("AudioEndpoint")));
    }
}


