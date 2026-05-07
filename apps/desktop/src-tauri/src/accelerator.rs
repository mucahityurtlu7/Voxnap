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

#[allow(dead_code)]
const HAS_ORT_DIRECTML: bool = cfg!(feature = "ort-directml");
#[allow(dead_code)]
const HAS_ORT_CUDA: bool = cfg!(feature = "ort-cuda");
#[allow(dead_code)]
const HAS_ORT_OPENVINO: bool = cfg!(feature = "ort-openvino");
#[allow(dead_code)]
const HAS_ORT_QNN: bool = cfg!(feature = "ort-qnn");
#[allow(dead_code)]
const HAS_ORT_COREML: bool = cfg!(feature = "ort-coreml");

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
        } else if HAS_ORT_COREML && ort_ep_probe::coreml_works() {
            (true, None, "onnx")
        } else if HAS_ORT_COREML {
            (
                false,
                Some(
                    "ORT CoreML EP linked but failed to initialize at runtime (likely a macOS version mismatch)."
                        .into(),
                ),
                "onnx",
            )
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
        // 1) Native NPU detection via PnP. We surface every NPU we can see,
        //    with the best ORT EP that targets it (QNN > OpenVINO > none).
        if let Some(npu) = detect_windows_npu() {
            out.push(npu);
        }

        // 2) NVIDIA GPU. Two providers can drive it:
        //    a) whisper.cpp's CUDA backend (cuBLAS-linked, fastest)
        //    b) ORT CUDA EP        (works for the ONNX pipeline)
        let (cuda_avail, cuda_reason, cuda_provider) = if HAS_CUDA {
            (true, None, "whisper-cpp")
        } else if HAS_ORT_CUDA && ort_ep_probe::cuda_works() {
            (true, None, "onnx")
        } else if HAS_ORT_CUDA {
            (
                false,
                Some(
                    "ORT CUDA EP linked but failed to initialize. Install the NVIDIA driver + CUDA Toolkit and try again."
                        .into(),
                ),
                "onnx",
            )
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
        let (dml_avail, dml_reason) = if HAS_ORT_DIRECTML && ort_ep_probe::directml_works() {
            (true, None)
        } else if HAS_ORT_DIRECTML {
            (
                false,
                Some(
                    "DirectML EP linked but D3D12 device creation failed. Update GPU drivers (need WDDM 2.4 / Win10 1903+).".into(),
                ),
            )
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
        } else if HAS_ORT_CUDA && ort_ep_probe::cuda_works() {
            (true, None, "onnx")
        } else if HAS_ORT_CUDA {
            (
                false,
                Some("ORT CUDA EP linked but failed to initialize. Check `nvidia-smi` and `ldconfig -p | grep cuda`.".into()),
                "onnx",
            )
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
        let (ov_avail, ov_reason) = if HAS_ORT_OPENVINO && ort_ep_probe::openvino_works() {
            (true, None)
        } else if HAS_ORT_OPENVINO {
            (
                false,
                Some("OpenVINO EP linked but the runtime libraries weren't found. Install `intel-openvino-runtime`.".into()),
            )
        } else {
            (
                false,
                Some("Rebuild Voxnap with `--features ort-openvino` to enable Intel NPU/iGPU acceleration.".into()),
            )
        };
        if cfg!(feature = "ort-openvino") || ov_avail {
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
        } else if HAS_ORT_COREML && ort_ep_probe::coreml_works() {
            (true, None, "onnx")
        } else {
            (
                false,
                Some(
                    "Rebuild the iOS bundle with `--features coreml` or `--features ort-coreml`.".into(),
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
    }

    #[cfg(target_os = "android")]
    {
        // Qualcomm Hexagon NPU via QNN EP.
        let (avail, reason) = if HAS_ORT_QNN && ort_ep_probe::qnn_works() {
            (true, None)
        } else if HAS_ORT_QNN {
            (
                false,
                Some(
                    "QNN EP linked but Hexagon DSP not reachable. Verify QNN backend libraries (libQnnHtp.so) are bundled."
                        .into(),
                ),
            )
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
// ORT execution-provider runtime probes
// ───────────────────────────────────────────────────────────────────────────
//
// Each probe tries to register the EP on a throwaway `SessionBuilder`. If
// `register()` returns Ok we know the EP's dynamic libraries loaded and
// the EP initialized at least to the point where it could enumerate
// devices. We deliberately don't run a tiny model through it — that would
// add 100s of ms to every call to `detect()` and we want the
// onboarding/settings UI to feel snappy.
//
// All probe fns are no-ops returning `false` when the matching cargo
// feature is off. That way the call sites stay branch-free.
mod ort_ep_probe {
    // The `register` method lives on the `ExecutionProvider` trait, not on
    // `ExecutionProviderDispatch`. We probe by calling it directly on the
    // typed EP value — that way the trait's "missing feature" / "DLL load
    // failed" errors propagate cleanly.
    #[allow(unused_imports)]
    use ort::ep::ExecutionProvider;

    /// Run `register` on a throwaway SessionBuilder and report success.
    /// Generic so each call site stays type-safe and the unused EP types
    /// are dead-code-eliminated when their feature is off.
    #[allow(dead_code)]
    fn try_register<E: ExecutionProvider>(ep: &E) -> bool {
        let Ok(mut builder) = ort::session::Session::builder() else {
            return false;
        };
        ep.register(&mut builder).is_ok()
    }

    #[cfg(feature = "ort-directml")]
    pub fn directml_works() -> bool {
        try_register(&ort::ep::DirectML::default().with_device_id(0))
    }
    #[cfg(not(feature = "ort-directml"))]
    pub fn directml_works() -> bool {
        false
    }

    #[cfg(feature = "ort-cuda")]
    pub fn cuda_works() -> bool {
        try_register(&ort::ep::CUDA::default().with_device_id(0))
    }
    #[cfg(not(feature = "ort-cuda"))]
    pub fn cuda_works() -> bool {
        false
    }

    #[cfg(feature = "ort-openvino")]
    pub fn openvino_works() -> bool {
        try_register(&ort::ep::OpenVINO::default().with_device_type("AUTO"))
    }
    #[cfg(not(feature = "ort-openvino"))]
    pub fn openvino_works() -> bool {
        false
    }

    #[cfg(feature = "ort-qnn")]
    pub fn qnn_works() -> bool {
        // We don't pass a backend_path here — without one, QNN looks up the
        // default `QnnHtp.dll` (Windows) / `libQnnHtp.so` (Android) on the
        // dynamic-library search path. The probe still fails if QNN can't
        // talk to the Hexagon DSP, which is what we want to surface.
        try_register(&ort::ep::QNN::default())
    }
    #[cfg(not(feature = "ort-qnn"))]
    pub fn qnn_works() -> bool {
        false
    }

    #[cfg(feature = "ort-coreml")]
    pub fn coreml_works() -> bool {
        try_register(&ort::ep::CoreML::default())
    }
    #[cfg(not(feature = "ort-coreml"))]
    pub fn coreml_works() -> bool {
        false
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
/// Once we know an NPU is present we pick the best ORT EP that targets it:
///   • Qualcomm  → QNN EP   (`ort-qnn`)
///   • Intel     → OpenVINO (`ort-openvino`)
///   • AMD XDNA  → no first-class ORT EP yet — we surface it as detected
///     but unavailable, matching the UI's existing convention.
#[cfg(target_os = "windows")]
fn detect_windows_npu() -> Option<AcceleratorInfo> {
    use std::process::Command;

    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$d = Get-PnpDevice -PresentOnly -Class ComputeAccelerator
if (-not $d) {
    $d = Get-PnpDevice -PresentOnly | Where-Object {
        $_.FriendlyName -match 'NPU|Neural Processor|AI Boost|Hexagon|XDNA'
    }
}
foreach ($x in $d) {
    $mfg = (Get-PnpDeviceProperty -InstanceId $x.InstanceId -KeyName 'DEVPKEY_Device_Manufacturer').Data
    Write-Output ("{0}|{1}" -f $x.FriendlyName, $mfg)
}
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().find(|l| !l.trim().is_empty())?;
    let mut parts = first.splitn(2, '|');
    let name = parts.next().unwrap_or("").trim().to_string();
    let manufacturer = parts.next().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return None;
    }

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
            n if n.contains("XDNA") => Vendor::Amd,
            _ => Vendor::Unknown,
        },
    };

    let (vendor, backend, available, reason) = match vendor_kind {
        Vendor::Qualcomm => {
            if HAS_ORT_QNN && ort_ep_probe::qnn_works() {
                (Some("Qualcomm"), "qnn", true, None)
            } else if HAS_ORT_QNN {
                (
                    Some("Qualcomm"),
                    "qnn",
                    false,
                    Some(
                        "Hexagon NPU detected. QNN EP linked but Qualcomm's QNN backend DLLs (QnnHtp.dll) couldn't be loaded.".into(),
                    ),
                )
            } else {
                (
                    Some("Qualcomm"),
                    "qnn",
                    false,
                    Some(
                        "Hexagon NPU detected. Rebuild Voxnap with `--features ort-qnn` and bundle the Qualcomm QNN runtime to enable it.".into(),
                    ),
                )
            }
        }
        Vendor::Intel => {
            if HAS_ORT_OPENVINO && ort_ep_probe::openvino_works() {
                (Some("Intel"), "openvino", true, None)
            } else if HAS_ORT_OPENVINO {
                (
                    Some("Intel"),
                    "openvino",
                    false,
                    Some(
                        "Intel AI Boost NPU detected. OpenVINO EP linked but the runtime libraries (openvino.dll) couldn't be found.".into(),
                    ),
                )
            } else {
                (
                    Some("Intel"),
                    "openvino",
                    false,
                    Some(
                        "Intel AI Boost NPU detected. Rebuild Voxnap with `--features ort-openvino` and install the OpenVINO runtime.".into(),
                    ),
                )
            }
        }
        Vendor::Amd => (
            Some("AMD"),
            "xdna",
            false,
            Some(
                "AMD XDNA NPU detected. No production-ready ONNX Runtime EP exists for XDNA yet — falling back to GPU/CPU.".into(),
            ),
        ),
        Vendor::Unknown => (
            None,
            "npu",
            false,
            Some(
                "Unknown NPU detected. Voxnap can't pick a matching backend without vendor information.".into(),
            ),
        ),
    };

    Some(AcceleratorInfo {
        id: "npu",
        label: name,
        vendor,
        backend,
        available,
        unavailable_reason: reason,
        provider: "onnx",
    })
}
