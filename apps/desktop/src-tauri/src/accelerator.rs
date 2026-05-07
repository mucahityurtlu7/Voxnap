//! Compute-accelerator detection.
//!
//! Voxnap can route whisper.cpp inference at one of three buckets:
//!
//!   • `npu` — neural-processing-unit / dedicated AI accelerator
//!   • `gpu` — discrete or integrated GPU compute (Metal / CUDA / Vulkan)
//!   • `cpu` — pure-CPU whisper.cpp (always available)
//!
//! Two things have to line up before a particular accelerator is *usable*:
//!
//!   1. **Build** — the matching `whisper-rs` cargo feature has to have been
//!      compiled in. We can't enable backends at runtime; whisper.cpp links
//!      them in at build time.
//!   2. **Host hardware** — the machine actually has to ship the accelerator
//!      (e.g. an Apple Neural Engine on Apple Silicon, an NVIDIA GPU on a
//!      desktop with `cuda` feature enabled, …).
//!
//! `detect()` reports every accelerator we can *plausibly* offer on this
//! host along with `available: bool` so the UI can show greyed-out rows
//! with an actionable hint ("rebuild with `--features coreml` to enable").
//! It always appends a CPU entry at the bottom so the picker is never
//! empty.

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
    /// whisper.cpp backend identifier (`"coreml" | "metal" | "cuda" | "cpu" | …`).
    pub backend: &'static str,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// True iff the desktop binary was compiled with `whisper-rs`'s `coreml`
/// feature, which is the only way Apple's Neural Engine path lights up.
const HAS_COREML: bool = cfg!(feature = "coreml");
/// Apple GPU (Metal) backend — what whisper.cpp falls back to when the
/// CoreML model isn't present, or the chosen architecture doesn't ship a
/// CoreML encoder.
const HAS_METAL: bool = cfg!(feature = "metal");
/// NVIDIA CUDA backend.
const HAS_CUDA: bool = cfg!(feature = "cuda");
/// CPU acceleration via OpenBLAS — informational only; we treat this as
/// "still CPU" for the UI's NPU/GPU/CPU bucketing.
#[allow(dead_code)]
const HAS_OPENBLAS: bool = cfg!(feature = "openblas");

/// Detect compute accelerators offered by this host + binary.
///
/// The list is ordered most-preferred first, matching the order the engine
/// would pick under `computeBackend = "auto"` (NPU → GPU → CPU).
pub fn detect() -> Vec<AcceleratorInfo> {
    let mut out: Vec<AcceleratorInfo> = Vec::new();

    // ─── macOS / Apple Silicon ──────────────────────────────────────────
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        // Apple Silicon ships ANE on every M-series chip.
        let reason = if !HAS_COREML {
            Some(
                "Rebuild Voxnap with `cargo build --features coreml` to enable Apple Neural Engine acceleration."
                    .to_string(),
            )
        } else {
            None
        };
        out.push(AcceleratorInfo {
            id: "npu",
            label: "Apple Neural Engine".to_string(),
            vendor: Some("Apple"),
            backend: "coreml",
            available: HAS_COREML,
            unavailable_reason: reason,
        });

        let metal_reason = if !HAS_METAL {
            Some(
                "Rebuild Voxnap with `cargo build --features metal` to enable Apple GPU (Metal) acceleration."
                    .to_string(),
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
        });
    }

    // ─── macOS / Intel ──────────────────────────────────────────────────
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        // Intel Macs have no NPU; only Metal-capable GPU.
        let metal_reason = if !HAS_METAL {
            Some(
                "Rebuild Voxnap with `cargo build --features metal` to enable GPU acceleration."
                    .to_string(),
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
        });
    }

    // ─── Windows ────────────────────────────────────────────────────────
    #[cfg(target_os = "windows")]
    {
        if let Some(npu) = detect_windows_npu() {
            out.push(npu);
        }
        // Most Windows machines have a discrete or integrated GPU. We can't
        // probe the driver at runtime without pulling in nvml/d3d12, so we
        // just announce CUDA based on the build feature and let users see
        // it greyed out on AMD/Intel boxes.
        let cuda_reason = if !HAS_CUDA {
            Some(
                "Rebuild Voxnap with `cargo build --features cuda` to enable NVIDIA GPU acceleration."
                    .to_string(),
            )
        } else {
            None
        };
        out.push(AcceleratorInfo {
            id: "gpu",
            label: "NVIDIA GPU (CUDA)".to_string(),
            vendor: Some("NVIDIA"),
            backend: "cuda",
            available: HAS_CUDA,
            unavailable_reason: cuda_reason,
        });
    }

    // ─── Linux ──────────────────────────────────────────────────────────
    #[cfg(target_os = "linux")]
    {
        let cuda_reason = if !HAS_CUDA {
            Some(
                "Rebuild Voxnap with `cargo build --features cuda` to enable NVIDIA GPU acceleration."
                    .to_string(),
            )
        } else {
            None
        };
        out.push(AcceleratorInfo {
            id: "gpu",
            label: "NVIDIA GPU (CUDA)".to_string(),
            vendor: Some("NVIDIA"),
            backend: "cuda",
            available: HAS_CUDA,
            unavailable_reason: cuda_reason,
        });
    }

    // ─── Mobile (iOS / Android) ─────────────────────────────────────────
    #[cfg(target_os = "ios")]
    {
        let reason = if !HAS_COREML {
            Some(
                "Rebuild the iOS bundle with `cargo build --features coreml` to enable Apple Neural Engine acceleration."
                    .to_string(),
            )
        } else {
            None
        };
        out.push(AcceleratorInfo {
            id: "npu",
            label: "Apple Neural Engine".to_string(),
            vendor: Some("Apple"),
            backend: "coreml",
            available: HAS_COREML,
            unavailable_reason: reason,
        });
    }

    #[cfg(target_os = "android")]
    {
        // Qualcomm Hexagon NPU is the most common case but whisper.cpp's
        // QNN backend is still experimental and we don't ship a feature for
        // it yet; surface it as detected-but-not-wired so the UI shows the
        // capability honestly.
        out.push(AcceleratorInfo {
            id: "npu",
            label: "Qualcomm Hexagon NPU".to_string(),
            vendor: Some("Qualcomm"),
            backend: "qnn",
            available: false,
            unavailable_reason: Some(
                "On-device NPU acceleration on Android is experimental and not yet bundled with Voxnap. Falling back to CPU."
                    .to_string(),
            ),
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

/// Best-effort Windows NPU probe.
///
/// Windows 11 24H2+ exposes Copilot+ NPUs (Qualcomm Hexagon, Intel AI Boost,
/// AMD XDNA) through PnP. We shell out to `wmic` because it's already on
/// every supported Windows host and avoids pulling in `windows-sys` just
/// for one query. If we can't run `wmic` for any reason we just return
/// `None` — the user will see GPU/CPU options and that's fine.
#[cfg(target_os = "windows")]
fn detect_windows_npu() -> Option<AcceleratorInfo> {
    use std::process::Command;
    let output = Command::new("wmic")
        .args([
            "path",
            "Win32_PnPEntity",
            "where",
            "Name like '%NPU%' or Name like '%Neural Processor%' or Name like '%AI Boost%' or Name like '%Hexagon%'",
            "get",
            "Name,Manufacturer",
            "/format:list",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut name: Option<String> = None;
    let mut manufacturer: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Name=") {
            let v = rest.trim();
            if !v.is_empty() {
                name = Some(v.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("Manufacturer=") {
            let v = rest.trim();
            if !v.is_empty() {
                manufacturer = Some(v.to_string());
            }
        }
    }

    let label = name.unwrap_or_else(|| "Windows NPU".to_string());
    let vendor: Option<&'static str> = match manufacturer.as_deref() {
        Some(m) if m.contains("Qualcomm") => Some("Qualcomm"),
        Some(m) if m.contains("Intel") => Some("Intel"),
        Some(m) if m.contains("AMD") || m.contains("Advanced Micro") => Some("AMD"),
        _ => None,
    };

    Some(AcceleratorInfo {
        id: "npu",
        label,
        vendor,
        backend: "npu",
        // We don't yet ship a whisper.cpp NPU backend on Windows (no
        // feature flag wired), so even when detected the accelerator is
        // not actually usable. Showing it honestly is more useful than
        // hiding it — users see "yes Voxnap saw your NPU, support is
        // coming".
        available: false,
        unavailable_reason: Some(
            "Voxnap detected a Windows NPU but on-device NPU acceleration is not yet bundled. Falling back to GPU/CPU."
                .to_string(),
        ),
    })
}
