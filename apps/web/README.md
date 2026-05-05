# @voxnap/web

In-browser build of Voxnap. Pure Vite SPA — no Tauri, no servers.

```
src/
├─ main.tsx                       ← mounts <App> with WasmEngine
├─ index.css
└─ workers/
   ├─ pcm-capture.worklet.ts      ← AudioWorkletNode → 16 kHz mono f32
   └─ whisper.worker.ts           ← whisper.wasm worker (loaded by WasmEngine)
public/
└─ whisper/                       ← drop ggml-*.bin + whisper.wasm here
```

## Run

```bash
pnpm dev:web                      # http://localhost:5173
```

The `WasmEngine` lazy-loads `/whisper/whisper.wasm` and the configured model
from `/whisper/ggml-<modelId>.bin` (cached in IndexedDB after the first
load). See `apps/web/public/whisper/README.md` for how to populate that
folder — `pnpm fetch:model <id> --out apps/web/public/whisper` works too.

## Notes

- `getUserMedia` requires HTTPS on real domains; localhost is exempt.
- Cross-origin isolation is **not** required for our worker setup, but if
  you add `SharedArrayBuffer` + threaded whisper.wasm, set
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` in your hosting.
- The same `useTranscription()` hook used by desktop / mobile drives the UI;
  the only difference is which engine is provided.
