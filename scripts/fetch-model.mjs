#!/usr/bin/env node
/**
 * fetch-model.mjs — download whisper.cpp ggml models from Hugging Face.
 *
 * Usage:
 *   node scripts/fetch-model.mjs [<modelId>] [--out <dir>]
 *
 * Examples:
 *   node scripts/fetch-model.mjs base.q5_1
 *   node scripts/fetch-model.mjs small --out apps/web/public/whisper
 *
 * Defaults:
 *   modelId = "base.q5_1"
 *   out     = ./models  (the desktop bundler picks it up automatically)
 *
 * The script is intentionally dependency-free so it runs straight from the
 * repo without `pnpm install`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const KNOWN_MODELS = [
  // f16 (full-precision)
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v3",
  "large-v3-turbo",
  // q5_1 (multilingual + English-only)
  "tiny.q5_1",
  "tiny.en.q5_1",
  "base.q5_1",
  "base.en.q5_1",
  "small.q5_1",
  "small.en.q5_1",
  // q5_0 (medium + large families have no q5_1 on HF)
  "medium.q5_0",
  "medium.en.q5_0",
  "large-v3.q5_0",
  "large-v3-turbo.q5_0",
];


const args = process.argv.slice(2);
let modelId = "base.q5_1";
let outDir = path.join(REPO_ROOT, "models");

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") {
    outDir = path.resolve(args[++i] ?? "");
  } else if (a === "--help" || a === "-h") {
    console.log(`Usage: node scripts/fetch-model.mjs [modelId] [--out dir]

Known models:
  ${KNOWN_MODELS.join(", ")}
`);
    process.exit(0);
  } else if (!a.startsWith("--")) {
    modelId = a;
  }
}

if (!KNOWN_MODELS.includes(modelId)) {
  console.warn(
    `[fetch-model] unknown model "${modelId}" — proceeding anyway (it must exist on Hugging Face).`,
  );
}

// Local filename keeps dots (e.g. ggml-base.q5_1.bin) — what whisper-rs expects.
const fileName = `ggml-${modelId}.bin`;
const hfFileName = toHuggingFaceFileName(modelId);
const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${hfFileName}?download=true`;

const outPath = path.join(outDir, fileName);

/**
 * Hugging Face repository uses a dash instead of a dot **only** before the
 * quant suffix (the last `.` in the id). The `.en` infix on English-only
 * models is preserved as-is. Examples:
 *   base.q5_1        → ggml-base-q5_1.bin
 *   tiny.en.q5_1     → ggml-tiny.en-q5_1.bin
 *   medium.q5_0      → ggml-medium-q5_0.bin
 *   large-v3         → ggml-large-v3.bin             (no quant suffix)
 *   tiny             → ggml-tiny.bin                 (no quant suffix)
 *
 * The previous implementation replaced *every* `.` with `-`, which broke
 * English-only quant URLs (`ggml-tiny-en-q5_1.bin` → 404 on HF).
 */
function toHuggingFaceFileName(id) {
  const lastDot = id.lastIndexOf(".");
  const hasQuantSuffix =
    lastDot >= 0 && /^q\d/.test(id.slice(lastDot + 1));
  const hfId = hasQuantSuffix
    ? `${id.slice(0, lastDot)}-${id.slice(lastDot + 1)}`
    : id;
  return `ggml-${hfId}.bin`;
}


fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(outPath)) {
  console.log(`[fetch-model] already present: ${outPath}`);
  process.exit(0);
}

console.log(`[fetch-model] downloading ${url}`);
console.log(`[fetch-model]      → ${outPath}`);

download(url, outPath)
  .then(() => console.log("[fetch-model] done."))
  .catch((err) => {
    console.error("[fetch-model] failed:", err.message);
    try {
      fs.unlinkSync(outPath);
    } catch {}
    process.exit(1);
  });

function download(srcUrl, dst) {
  return new Promise((resolve, reject) => {
    const tmp = dst + ".part";
    const file = fs.createWriteStream(tmp);

    const req = https.get(srcUrl, { headers: { "user-agent": "voxnap-fetch-model" } }, (res) => {
      // Follow redirects (HF redirects to a CDN).
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
          process.stdout.write(`\r[fetch-model] ${pct}% (${(received / 1e6).toFixed(1)} MB)`);
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          process.stdout.write("\n");
          fs.renameSync(tmp, dst);
          resolve();
        });
      });
    });
    req.on("error", reject);
    file.on("error", reject);
  });
}
