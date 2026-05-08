# NPU & GPU acceleration via ONNX Runtime

> Status: **Phase 3 complete** — the ONNX pipeline now ships full
> feature parity with whisper.cpp (KV-cache reuse, partial emissions,
> timestamp tokens, length-normalised small-beam search) *and* the CI
> release matrix carries a Voxnap-Universal artifact that bundles every
> ORT execution provider behind a single Windows installer. Per-EP
> smoke tests on `cargo test --lib --features ort-*` keep the
> dispatcher / detection invariants honest across every cargo-feature
> combination. The default Voxnap build still keeps the proven
> whisper.cpp pipeline; opt in to the ONNX path by building with the
> matching `ort-*` cargo feature(s) and the matching ONNX runtime
> libraries — or just download the Voxnap-Universal release for
> hands-off NPU support on Copilot+ / Core Ultra / Snapdragon X
> hardware.




## TL;DR — what changed

Voxnap now ships **two parallel inference pipelines**, picked at runtime
based on the user's compute-backend preference:

| Pipeline      | Crate         | Backends covered                                  | Owns        |
| ------------- | ------------- | ------------------------------------------------- | ----------- |
| `whisper-cpp` | `whisper-rs`  | CoreML, Metal, CUDA, CPU                          | `whisper.rs` |
| `onnx`        | `ort`         | DirectML, CUDA, OpenVINO (Intel NPU+iGPU), QNN (Hexagon), CoreML | `onnx_engine.rs` |

The `commands::pick_provider` dispatcher reads
`accelerator::detect()` and routes the recording to whichever pipeline
actually has the requested accelerator wired up.

If neither pipeline can serve the requested backend, **the request silently
falls back to the whisper.cpp CPU path** — same behaviour as before this
change landed, so existing CI builds without any ORT feature keep
working unchanged.

## Build matrix

```bash
# Default — pure whisper.cpp + CPU. Smallest binary, runs everywhere.
cargo build

# whisper.cpp + NVIDIA CUDA. Requires the CUDA Toolkit + driver.
cargo build --features cuda

# ONNX + DirectML — works on every Win10 1903+ machine with a GPU.
# DirectML.dll ships with Windows; nothing else to install.
cargo build --features ort-directml

# ONNX + Intel NPU (AI Boost on Core Ultra) via OpenVINO.
# Needs the OpenVINO Runtime installed on the host.
cargo build --features ort-openvino

# ONNX + Qualcomm Hexagon NPU (Snapdragon X Elite Copilot+ PCs).
# Needs the QNN SDK runtime DLLs bundled next to the executable.
cargo build --features ort-qnn

# ONNX + NVIDIA CUDA EP (alternative to whisper.cpp's CUDA — useful when
# you want the same model file to run across both pipelines).
cargo build --features ort-cuda

# ONNX + Apple ANE / GPU through ORT's CoreML EP (mac/iOS).
cargo build --features ort-coreml

# Everything ORT can offer at once. Used by the "Voxnap-Universal"
# CI artifact that flips every NPU/GPU bucket from "Not bundled" to
# detection-only.
cargo build --features ort-all
```

The runtime probe in `accelerator.rs` will only mark a row
`available: true` if both:

1. the matching cargo feature was compiled in, **and**
2. the EP's runtime libraries actually load on this host (DirectML.dll,
   `openvino.dll`, `libQnnHtp.so`, …).

That's why a build with `--features ort-openvino` on a machine without
the OpenVINO runtime still shows the row as **Unavailable**, with an
actionable hint in the description. The "Not bundled" badge is reserved
for *truly missing-from-build* cases (rebuild required); "Unavailable"
covers the runtime-library cases (install required).

## Fetching ONNX models

The `whisper-cpp` pipeline uses ggml `.bin` files; the `onnx` pipeline
uses HuggingFace's optimum-exported ONNX bundles, which look like:

```
<models-dir>/onnx/<modelId>/
    encoder.onnx
    decoder.onnx
    tokenizer.json
```

Run the fetcher:

```bash
# Default: base.en into ./models/onnx/base.en/
pnpm fetch:onnx-model

# Or pick a specific size:
node scripts/fetch-onnx-model.mjs small.en
node scripts/fetch-onnx-model.mjs large-v3 --out apps/desktop/models
```

The fetcher pulls from [Xenova/whisper-*](https://huggingface.co/Xenova),
which are the same exports the JS-side `@xenova/transformers` library uses,
so accuracy parity with the web SPA is automatic.

## Model file layout

| Pipeline      | Path under `<app-data>/models/`                          |
| ------------- | -------------------------------------------------------- |
| `whisper-cpp` | `ggml-<modelId>.bin`                                     |
| `onnx`        | `onnx/<modelId>/{encoder,decoder,tokenizer.json}`        |

Both `model_dir` and `resource_dir` are searched, plus dev-time
walks-up-from-cwd. See `whisper::resolve_model_path` and
`onnx_engine::resolve_model_dir`.

## Phase status

- **Phase 1** — accelerator runtime probing + UI badge split (`Not bundled` vs `Unavailable`). ✅
- **Phase 2A** — sync `OnnxWhisperEngine::transcribe` (greedy, no KV cache). ✅
- **Phase 2B** — streaming `onnx_engine::spawn` mirroring `whisper::spawn`, dispatcher in `commands.rs`. ✅
- **Phase 2C** — feature-parity gap with whisper.cpp closed. ✅
    - KV-cache reuse via `decoder_with_past.onnx` (auto-detected; falls back to O(n²) re-feed when missing). ✅
    - Partial emissions every 1.5 s during an in-progress utterance, dedup-suppressed against the previous partial — same `seg-live` UX as `whisper::spawn`. ✅
    - Timestamp-aware decoding: `OnnxConfig.timestamps` toggles the `<|notimestamps|>` SOT marker; `<|x.xx|>` tokens are stripped from the user-visible transcript via `WhisperTokenizer::is_timestamp` so `tokenizer.json` exports that don't classify them as "special" still produce clean text. ✅
    - Length-normalised small-beam search (`OnnxConfig.beam_size`) on the re-feed decoder, ((5+L)/6)^0.6 length penalty matching OpenAI's reference. The KV-cache greedy path stays the default since per-beam KV cloning loses to greedy-with-KV on every realistic Whisper size. ✅
- **Phase 3**  — operational rollout. ✅
    - **Voxnap-Universal release artifact.** `release.yml` adds a Windows
      x64 matrix entry that builds with `--features ort-all`, so a single
      `.msi` ships with DirectML + CUDA + OpenVINO + QNN execution
      providers. ORT's `download-binaries` cargo feature pulls the
      pre-built ORT 1.24 dylibs into the bundle, and
      `accelerator::detect()` lights up the matching row at runtime if
      the user's vendor SDK (DirectML.dll, openvino.dll, QnnHtp.dll, …)
      is on PATH. ✅
    - **Per-EP smoke tests.** `.github/workflows/ci.yml` compiles every
      `ort-*` feature plus `ort-all` in isolation and runs
      `cargo test --lib` on each combination. The unit tests in
      `accelerator.rs` / `commands.rs` / `onnx_engine.rs` lock down the
      dispatcher invariants — bucket ids, EP-list partitioning,
      "Unavailable" reasons, `pick_provider` round-trip — without
      needing real EP runtime libraries on the runner, so a typo'd
      `#[cfg]` guard or a moved EP constructor fails the PR rather than
      a tagged release. ✅
    - **Release-time hardware verification.** `release.yml` still keeps
      the `windows-x64-cuda` and `linux-x64-cuda` artifacts so NVIDIA
      paths get a separate hardware-tested binary alongside the
      Universal one. ✅

## Why two pipelines instead of replacing whisper.cpp

Both pipelines now offer the same feature surface (KV-cache reuse,
partial emissions, timestamps, small-beam search) and the Voxnap-
Universal release wraps every ORT execution provider in one installer,
so the dispatcher choice is purely about which **hardware** wins on the
user's machine at runtime. The dispatcher lets us:

- **Keep the proven path as default** — most users never notice ONNX exists.
- **Add NPU support** — the only practical way to drive Hexagon /
  AI Boost / DirectML today is through ORT's EP system.
- **Switch the dispatch decision per-session** without changing model
  files: `compute_backend = "auto"` stays on whisper.cpp; `"npu"` jumps
  to ONNX if (and only if) an NPU EP is actually available.

What's still ahead (post-Phase-3): per-word `EmittedSegment` enrichment
that exposes the Phase 2C timestamp tokens to the UI, and flipping the
default to ONNX on Windows / Android — both of which are now config-
only changes.


## Troubleshooting — "I have an NPU but Voxnap won't use it"

This is the most common confusion, so we've made it surfaceable from the
UI: open **Settings → Compute** (or the onboarding Compute step) and
click **"Diagnose NPU / GPU detection"**. The modal walks the user
through every detection channel:

1. **Compiled-in execution providers** — which `ort` / whisper.cpp
   features were baked into *this* binary. If the row your NPU needs
   is missing, no amount of driver work will help — you need a Voxnap
   build with that feature flag (or just download the
   **Voxnap-Universal** release artifact).
2. **EP probes** — for every compiled-in EP we try to register it on a
   throwaway ORT session and report the *exact* error string ORT
   returned. "DirectML EP linked but D3D12 device creation failed:
   HRESULT 0x887A0005 (DXGI_ERROR_DEVICE_HUNG)" is the kind of
   actionable message you'll see — not just "Unavailable".
3. **OS-level NPU PnP scan (Windows)** — three parallel passes
   (`Get-PnpDevice -Class ComputeAccelerator`, friendly-name regex
   match, and a CIM `Win32_VideoController` filter) merged + de-duped
   so the NPU surfaces even when one of the three returns nothing.

If the diagnostic says **"No device matched the ComputeAccelerator
class or the friendly-name fallback"** on a host that *should* have an
NPU, it's almost always one of:

- **NPU driver missing** — open Device Manager, look for "Neural
  processors" or yellow-bang devices, install the vendor driver
  (Intel NPU Driver, Qualcomm Hexagon Driver, AMD Ryzen AI Driver).
- **Windows out of date** — Copilot+ NPU PnP enumeration only landed
  in Windows 11 24H2. Older builds will *not* surface the NPU even
  though hardware is present. Run `winver`; if you're below 24H2,
  update.
- **Driver classifies the NPU under a private class** — some early
  Lunar Lake / Hawk Point drivers do this. Voxnap's friendly-name
  regex (`NPU|Neural Processor|AI Boost|Hexagon|XDNA|Ryzen AI`) covers
  most of them; if yours is missing, please open an issue with the
  output of:
  ```powershell
  Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -match 'AI|Neural|NPU' }
  ```

### Why the default Windows build now ships DirectML

Before this round of work the Windows desktop binary was built with
*no* ORT execution providers, so even on a perfectly working Copilot+
laptop the only available bucket was CPU. We now turn on `ort/directml`
unconditionally for `target_os = "windows"` (see the
`[target.…]` block in `apps/desktop/src-tauri/Cargo.toml`), because:

- DirectML.dll ships with every supported Windows version (10 1903+
  and all of Windows 11) — there is no link-time vendor SDK to bundle.
- Windows 11 24H2+ enumerates Copilot+ NPUs as D3D12 compute devices,
  which means **DirectML drives the NPU natively** for ops it
  supports. So a default `pnpm build:desktop` on Windows now lights up
  the NPU/GPU bucket out of the box, without any `--features`
  juggling.

QNN and OpenVINO still need their vendor SDKs at link time, so they
remain opt-in via `--features ort-qnn` / `--features ort-openvino`.
For users who want the full NPU-native experience (lower latency,
higher throughput than DirectML), the **Voxnap-Universal** release
artifact bundles all four EPs at once.

### Why `auto` now picks the NPU

Previously `pick_provider("auto")` always returned `whisper-cpp`,
which meant the runtime never even tried to open the ONNX session —
even when DirectML, CoreML or CUDA were available. The dispatcher in
`apps/desktop/src-tauri/src/commands.rs` now walks
`accelerator::detect()` in NPU > GPU > CPU order and dispatches to
whichever pipeline the first available row claims. The user only needs
to leave the picker on `Auto` (the default) and the NPU just works.



