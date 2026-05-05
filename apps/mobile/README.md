# @voxnap/mobile

Tauri 2 Mobile shell for iOS and Android. The frontend is identical to
desktop. The Rust crate (`src-tauri/`) is **just a shim**: it depends on
`voxnap-desktop` via a path-dependency and re-exports its `run()` so the
exact same cpal + whisper-rs pipeline ships on phones.

## Prereqs

- Tauri Mobile CLI (`pnpm --filter @voxnap/mobile tauri --version`).
- iOS: Xcode 15+, an Apple ID configured for development.
- Android: Android Studio + NDK r26+, `ANDROID_HOME` and `NDK_HOME` set.

```bash
# One-time scaffolding (creates platform projects under src-tauri/gen/):
pnpm --filter @voxnap/mobile tauri ios init
pnpm --filter @voxnap/mobile tauri android init
```

## Run

```bash
# iOS Simulator (or attached device):
pnpm dev:mobile:ios

# Android emulator (or attached device):
pnpm dev:mobile:android
```

## Notes

- The default mic device is used; `voxnap_list_devices` may return an empty
  list on iOS — that's fine.
- Models live under `<app-data>/models/ggml-<id>.bin`. Use the file dialog
  in the Settings page to import a `.bin` you've downloaded on the device,
  or bundle one as a Tauri resource for shipping.
