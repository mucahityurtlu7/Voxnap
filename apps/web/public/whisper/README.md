# Whisper model directory

Drop your `ggml-*.bin` model files here. They are git-ignored.

Quick start:

```
pnpm fetch:model base.q5_1
```

This downloads `ggml-base.q5_1.bin` from
https://huggingface.co/ggerganov/whisper.cpp into the appropriate directory.

To run the web build with a real model + WASM:

1. Place the whisper.wasm assets in this folder (`libmain.js`, `whisper.wasm`),
   built from `whisper.cpp/examples/whisper.wasm`.
2. Set `VITE_ENGINE=wasm` and (optionally) `VITE_MODEL=base.q5_1` in
   `apps/web/.env.local`.
3. `pnpm dev:web`.
