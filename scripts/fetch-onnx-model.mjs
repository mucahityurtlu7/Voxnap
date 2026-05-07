#!/usr/bin/env node
/**
 * fetch-onnx-model.mjs — download an ONNX-exported Whisper bundle from
 * Hugging Face for the `OnnxWhisperEngine` pipeline.
 *
 * The ONNX path needs three artefacts per model:
 *
 *   • encoder.onnx         — mel → encoder hidden states
 *   • decoder.onnx         — initial pass; emits logits + KV cache
 *   • tokenizer.json       — HF byte-BPE tokenizer with Whisper specials
 *
 * Optionally, `decoder_with_past.onnx` can be added later (Phase 2C) for
 * KV-cache reuse — same family of files, same fetcher.
 *
 * Source repository
 * -----------------
 * We grab them from Xenova's optimum-exported mirrors on HF:
 *
 *   https://huggingface.co/Xenova/whisper-<modelId>/tree/main/onnx
 *
 * Xenova's bundles are quantized to int8 for the encoder and fp32 for the
 * decoder by default, which gives the best accuracy/size trade-off across
 * every supported EP (DirectML / CUDA / OpenVINO / QNN / CoreML).
 *
 * Usage:
 *
 *   node scripts/fetch-onnx-model.mjs [<modelId>]
 *   node scripts/fetch-onnx-model.mjs base.en --out apps/desktop/models
 *
 * Defaults:
 *   modelId = base.en   (fast, English-only — best smoke-test target)
 *   out     = ./models  (the desktop bundler's "onnx/<modelId>/" subdir is
 *                        created automatically)
 *
 * Why not reuse `fetch-model.mjs`
 * -------------------------------
 * The ggml format used by whisper.cpp is *one* binary file per model;
 * ONNX exports are a directory of files with a different naming scheme
 * and a different (quantized) repo. Sharing logic would have meant
 * forking both branches anyway, so keeping the two scripts separate is
 * the cleaner choice.
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Logical id → Xenova HF repo slug.
 *
 * The Xenova mirrors only ship a subset of Whisper variants; the q5/q8
 * quantizations whisper.cpp uses don't translate to ONNX at all (a
 * different quantization scheme is used, baked into the export). We list
 * the ones that *do* exist on HF so the script fails fast for unknown ids.
 */
const XENOVA_MODELS = {
  "tiny": "whisper-tiny",
  "tiny.en": "whisper-tiny.en",
  "base": "whisper-base",
  "base.en": "whisper-base.en",
  "small": "whisper-small",
  "small.en": "whisper-small.en",
  "medium": "whisper-medium",
  "medium.en": "whisper-medium.en",
  "large-v3": "whisper-large-v3",
  "large-v3-turbo": "whisper-large-v3-turbo",
};

const FILES = ["encoder.onnx", "decoder.onnx", "tokenizer.json"];

const args = process.argv.slice(2);
let modelId = "base.en";
let outDir = path.join(REPO_ROOT, "models");

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") {
    outDir = path.resolve(args[++i] ?? "");
  } else if (a === "--help" || a === "-h") {
    console.log(`Usage: node scripts/fetch-onnx-model.mjs [modelId] [--out dir]

Known model ids:
  ${Object.keys(XENOVA_MODELS).join(", ")}

Each fetch downloads three files into <out>/onnx/<modelId>/:
  encoder.onnx, decoder.onnx, tokenizer.json
`);
    process.exit(0);
  } else if (!a.startsWith("--")) {
    modelId = a;
  }
}

if (!XENOVA_MODELS[modelId]) {
  console.error(
    `[fetch-onnx-model] unknown model "${modelId}". Known ids: ${Object.keys(XENOVA_MODELS).join(", ")}`,
  );
  process.exit(1);
}

const repo = XENOVA_MODELS[modelId];
const targetDir = path.join(outDir, "onnx", modelId);
fs.mkdirSync(targetDir, { recursive: true });

console.log(`[fetch-onnx-model] downloading "${modelId}" from Xenova/${repo}`);
console.log(`[fetch-onnx-model]            → ${targetDir}`);

(async () => {
  for (const fname of FILES) {
    const dst = path.join(targetDir, fname);
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
      console.log(`[fetch-onnx-model]   ✓ ${fname} (already present)`);
      continue;
    }
    // Tokenizer lives at the repo root; the two ONNX graphs live in /onnx.
    const remoteSubpath =
      fname === "tokenizer.json" ? fname : `onnx/${fname}`;
    const url = `https://huggingface.co/Xenova/${repo}/resolve/main/${remoteSubpath}?download=true`;
    process.stdout.write(`[fetch-onnx-model]   • ${fname} … `);
    try {
      await download(url, dst);
      process.stdout.write("done\n");
    } catch (err) {
      process.stdout.write(`failed: ${err.message}\n`);
      process.exit(1);
    }
  }
  console.log("[fetch-onnx-model] all files ready.");
})();

function download(srcUrl, dst) {
  return new Promise((resolve, reject) => {
    const tmp = dst + ".part";
    const file = fs.createWriteStream(tmp);

    const req = https.get(
      srcUrl,
      { headers: { "user-agent": "voxnap-fetch-onnx-model" } },
      (res) => {
        // Follow redirects (HF redirects to a CDN).
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          download(res.headers.location, dst).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${srcUrl}`));
          res.resume();
          return;
        }

        const total = Number(res.headers["content-length"] ?? 0);
        let received = 0;
        let lastLogged = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total && received - lastLogged > 1024 * 1024 * 5) {
            lastLogged = received;
            const pct = ((received / total) * 100).toFixed(1);
            process.stdout.write(
              `\r[fetch-onnx-model]   • progress ${pct}% (${(received / 1e6).toFixed(1)} MB)`,
            );
          }
        });
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            try {
              fs.renameSync(tmp, dst);
            } catch (e) {
              reject(e);
              return;
            }
            resolve();
          });
        });
      },
    );
    req.on("error", reject);
    file.on("error", reject);
  });
}
