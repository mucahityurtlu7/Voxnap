import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the web build.
 *
 * Worker handling:
 *   - The whisper worker is loaded via `new Worker(new URL("./workers/whisper.worker.ts", import.meta.url))`
 *     in `src/main.tsx` so Vite emits it as a separate chunk.
 *   - The PCM AudioWorklet is loaded with the `?worker&url` query so Vite
 *     copies the compiled file to the build output and gives us a stable URL.
 *
 * Transformers.js notes:
 *   - `@xenova/transformers` ships precompiled WASM/ONNX runtime binaries.
 *     We exclude it from Vite's dep optimisation so those files aren't
 *     re-bundled (which would break dynamic imports of the WASM glue).
 *   - The library uses `import.meta.url` to locate its assets, which
 *     works out of the box with Vite's ES-module workers.
 *
 * GitHub Pages base path:
 *   - When deployed to `https://<user>.github.io/<repo>/` Vite needs to know
 *     about the `/<repo>/` prefix so asset URLs resolve. The CI workflow
 *     (`.github/workflows/web.yml`) sets `VITE_BASE_PATH=/Voxnap/` for the
 *     production build; locally `pnpm dev:web` uses `/` so nothing changes.
 */
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    headers: {
      // Some Whisper backends (notably WebGPU + threaded WASM) require
      // cross-origin isolation. Setting these unconditionally is safe and
      // unlocks SharedArrayBuffer when transformers.js needs it.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
    // @voxnap/* packages point to raw TypeScript source files.
    // Including them in `include` causes Vite to pre-bundle AND watch them
    // at the same time, which triggers cascading "module not found" errors
    // during HMR. Vite resolves workspace source packages natively — no
    // explicit entry needed here.
    exclude: ["@xenova/transformers"],
  },
});
