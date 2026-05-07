# NPU & GPU acceleration via ONNX Runtime

> Status: **Phase 2B** — wiring complete, end-to-end smoke-testable.
> The default Voxnap build still runs the proven whisper.cpp pipeline.
> Build with the right `ort-*` cargo feature(s) and the matching ONNX
> runtime libraries to flip Voxnap onto the new hardware.

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
- **Phase 2C** — KV cache reuse (`decoder_with_past.onnx`), timestamp tokens, beam search. *Pending.*
- **Phase 3**  — EP DLL bundling in CI release matrix (Voxnap-Universal artifact), per-EP smoke tests. *Pending.*

## Why two pipelines instead of replacing whisper.cpp

whisper.cpp ships several quality-of-life features the ONNX pipeline
doesn't have yet (small-beam search, partial emissions per 1.5 s,
KV-cache reuse). The dispatcher lets us:

- **Keep the proven path as default** — most users never notice ONNX exists.
- **Add NPU support** — the only practical way to drive Hexagon /
  AI Boost / DirectML today is through ORT's EP system.
- **Switch the dispatch decision per-session** without changing model
  files: `compute_backend = "auto"` stays on whisper.cpp; `"npu"` jumps
  to ONNX if (and only if) an NPU EP is actually available.

Once Phase 2C lands and the ONNX pipeline reaches feature parity, we'll
revisit whether to make it the default on Windows/Android (where it
covers more hardware).
