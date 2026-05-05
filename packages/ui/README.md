# @voxnap/ui

Shared React UI for Voxnap. Re-exports an `App` component plus the
individual pages, hooks and primitives so the three runtimes (`apps/desktop`,
`apps/mobile`, `apps/web`) all render the same tree:

```tsx
import { TauriEngine } from "@voxnap/core";
import { App, EngineProvider } from "@voxnap/ui";

<EngineProvider engine={new TauriEngine()}>
  <App router="hash" />
</EngineProvider>
```

What lives here:

- `engine/EngineProvider.tsx` — context that holds the active engine.
- `hooks/useTranscription.ts` — start / stop, segments, partials, errors.
- `components/` — `MicButton`, `TranscriptView`, `WaveformBar`, `DeviceSelect`.
- `pages/` — `LiveTranscribePage`, `SettingsPage`.
- `tailwind.preset.cjs` + `styles.css` — Tailwind tokens shared by all apps.

Keep this package free of Tauri / Wasm imports — it must stay platform-blind.
