/**
 * @voxnap/core — public API barrel.
 *
 * Importers may either grab everything from the root:
 *
 *   import { TauriEngine, useTranscriptionStore } from "@voxnap/core";
 *
 * or use sub-paths for tree-shaking:
 *
 *   import { TauriEngine } from "@voxnap/core/engine";
 *   import { EnergyVad } from "@voxnap/core/audio";
 *   import { MockSummarizer } from "@voxnap/core/ai";
 *   import { MemorySessionStore, MOCK_SESSIONS } from "@voxnap/core/sessions";
 */
export * from "./types.js";
export * from "./engine/index.js";
export * from "./audio/index.js";
export * from "./store/index.js";
export * from "./ai/index.js";
export * from "./sessions/index.js";
