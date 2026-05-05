import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the Tauri desktop frontend.
 *
 * Tauri serves the dev frontend over a custom protocol; we need:
 *   - fixed dev port (Tauri reads it from `tauri.conf.json -> build.devUrl`)
 *   - clearScreen disabled so Tauri's logs are visible in the terminal
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
  },
});
