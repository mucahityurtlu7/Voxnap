import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the Tauri Mobile (iOS / Android) frontend.
 *
 * Tauri Mobile uses a fixed dev port and serves the bundle over
 * `http://<host>:<port>` to the device. We listen on 0.0.0.0 so devices on
 * the LAN can connect during dev.
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: "0.0.0.0",
    // HMR over LAN works best with a fixed port + the device's host IP set
    // via TAURI_DEV_HOST when running `tauri ios|android dev`.
    hmr: process.env.TAURI_DEV_HOST
      ? { protocol: "ws", host: process.env.TAURI_DEV_HOST, port: 1421 }
      : undefined,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
  },
});
