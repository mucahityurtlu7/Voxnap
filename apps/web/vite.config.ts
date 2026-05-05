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
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
    // Force pre-bundling of workspace deps so HMR works smoothly.
    include: ["@voxnap/core", "@voxnap/ui"],
  },
});
