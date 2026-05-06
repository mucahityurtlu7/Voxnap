/**
 * Voxnap shared types.
 *
 * These types are the lingua franca between every transcription engine
 * (Tauri-native, browser WASM, mock) and the UI layer.
 *
 * Keep this file framework-agnostic — no React, no Tauri imports.
 */

/**
 * Whisper model identifiers we ship.
 *
 * IDs match the file naming convention used on HuggingFace's
 * `ggerganov/whisper.cpp` repository. The dot before the quant suffix
 * (e.g. `.q5_1`) becomes a dash in the actual filename
 * (`ggml-base-q5_1.bin`), but the `.en` infix is kept as-is — see
 * `hfFileName()` in `scripts/fetch-model.mjs` and `hf_url_for` in
 * `apps/desktop/src-tauri/src/models.rs`.
 *
 * Only quantizations that actually exist on HF are listed; medium has no
 * q5_1 variant (only q5_0), and the large/turbo families likewise.
 */
export type WhisperModelId =
  | "tiny.q5_1"
  | "tiny.en.q5_1"
  | "base.q5_1"
  | "base.en.q5_1"
  | "small.q5_1"
  | "small.en.q5_1"
  | "medium.q5_0"
  | "medium.en.q5_0"
  | "large-v3.q5_0"
  | "large-v3-turbo.q5_0";

export interface WhisperModelInfo {
  id: WhisperModelId;
  /** Human-friendly label. */
  label: string;
  /** Approximate file size in MB (for UI hints / download progress). */
  approxSizeMb: number;
  /** True if model only handles English (faster, smaller). */
  englishOnly: boolean;
}

export const DEFAULT_MODEL: WhisperModelId = "base.q5_1";

export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelInfo> = {
  "tiny.q5_1": { id: "tiny.q5_1", label: "Tiny (multilingual)", approxSizeMb: 31, englishOnly: false },
  "tiny.en.q5_1": { id: "tiny.en.q5_1", label: "Tiny (English)", approxSizeMb: 31, englishOnly: true },
  "base.q5_1": { id: "base.q5_1", label: "Base (multilingual)", approxSizeMb: 57, englishOnly: false },
  "base.en.q5_1": { id: "base.en.q5_1", label: "Base (English)", approxSizeMb: 57, englishOnly: true },
  "small.q5_1": { id: "small.q5_1", label: "Small (multilingual)", approxSizeMb: 181, englishOnly: false },
  "small.en.q5_1": { id: "small.en.q5_1", label: "Small (English)", approxSizeMb: 181, englishOnly: true },
  "medium.q5_0": { id: "medium.q5_0", label: "Medium (multilingual)", approxSizeMb: 539, englishOnly: false },
  "medium.en.q5_0": { id: "medium.en.q5_0", label: "Medium (English)", approxSizeMb: 539, englishOnly: true },
  "large-v3.q5_0": { id: "large-v3.q5_0", label: "Large v3 (multilingual)", approxSizeMb: 1080, englishOnly: false },
  "large-v3-turbo.q5_0": { id: "large-v3-turbo.q5_0", label: "Large v3 Turbo (multilingual)", approxSizeMb: 547, englishOnly: false },
};


/** Audio input device exposed by the host (Tauri or browser). */
export interface AudioDevice {
  id: string;
  label: string;
  isDefault?: boolean;
  /** Loose categorisation for nicer device picker icons. */
  kind?: "microphone" | "headset" | "system" | "virtual";
}

/**
 * A single transcribed segment.
 *
 * `isFinal` distinguishes interim hypotheses (low-latency, may change)
 * from finalised results that won't be revised.
 */
export interface TranscriptionSegment {
  /** Stable id; interim updates re-use the same id until finalised. */
  id: string;
  text: string;
  /** Milliseconds from session start. */
  startMs: number;
  endMs: number;
  isFinal: boolean;
  /** 0..1, optional — engines that don't expose this leave it undefined. */
  confidence?: number;
  /** ISO language code if detected (e.g. "tr", "en"). */
  language?: string;
  /** Optional speaker id (diarization, currently mock-only). */
  speakerId?: string;
}

export interface AudioLevel {
  /** RMS level, 0..1. */
  rms: number;
  /** Peak level, 0..1. */
  peak: number;
  /** Wall-clock timestamp (ms) when the level was sampled. */
  at: number;
}

export interface EngineConfig {
  modelId: WhisperModelId;
  /** Override model file location (Tauri only). If unset, engine picks default. */
  modelPath?: string;
  /** ISO 639-1 code or "auto" for auto-detect. */
  language?: string | "auto";
  /** Translate to English while transcribing. */
  translate?: boolean;
  /** Number of threads for whisper.cpp (Tauri only). */
  threads?: number;
  /**
   * Energy-based VAD RMS threshold (0..1). Whisper is skipped when the
   * window RMS is below this value. Tauri only; defaults to 0.012.
   */
  vadThreshold?: number;
  /**
   * When `false`, VAD is bypassed and whisper always runs on every window.
   * Tauri only; defaults to `true`.
   */
  vadEnabled?: boolean;
}

/** Lifecycle states a transcription engine can be in. */
export type EngineState =
  | "idle"
  | "loading-model"
  | "ready"
  | "running"
  | "paused"
  | "error"
  | "disposed";

export interface EngineError {
  code:
    | "model-not-found"
    | "model-load-failed"
    | "audio-device-failed"
    | "permission-denied"
    | "engine-internal"
    | "not-supported";
  message: string;
  cause?: unknown;
}

// ---------------------------------------------------------------------------
// Speakers (mock-only diarization for now)
// ---------------------------------------------------------------------------

export interface Speaker {
  id: string;
  label: string;
  /** Tailwind-friendly accent class for UI badges. */
  color: SpeakerColor;
}

export type SpeakerColor =
  | "violet"
  | "sky"
  | "emerald"
  | "amber"
  | "rose"
  | "cyan"
  | "fuchsia";

// ---------------------------------------------------------------------------
// AI / Summaries
// ---------------------------------------------------------------------------

export type AiProvider = "mock" | "local" | "openai" | "anthropic" | "ollama";

export interface AiProviderInfo {
  id: AiProvider;
  label: string;
  /** True if the provider runs entirely on-device (no network). */
  local: boolean;
  /** True if the provider needs an API key. */
  needsApiKey: boolean;
}

export const AI_PROVIDERS: Record<AiProvider, AiProviderInfo> = {
  mock: { id: "mock", label: "Voxnap Mock", local: true, needsApiKey: false },
  local: { id: "local", label: "On-device (llama.cpp)", local: true, needsApiKey: false },
  openai: { id: "openai", label: "OpenAI", local: false, needsApiKey: true },
  anthropic: { id: "anthropic", label: "Anthropic", local: false, needsApiKey: true },
  ollama: { id: "ollama", label: "Ollama (LAN)", local: true, needsApiKey: false },
};

export type SummaryLength = "short" | "medium" | "long";

export type Sentiment = "positive" | "neutral" | "negative" | "mixed";

export interface ActionItem {
  id: string;
  text: string;
  /** Free-form owner label (e.g. "Mucahit", "Design team"). */
  owner?: string;
  /** ISO date string. */
  dueAt?: string;
  done: boolean;
  /** Anchor back into the transcript (ms from session start). */
  sourceMs?: number;
}

export interface Chapter {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  summary: string;
}

export interface SessionSummary {
  /** One-line headline. */
  tldr: string;
  /** 3-7 highlight bullets. */
  bullets: string[];
  decisions: string[];
  questions: string[];
  sentiment: Sentiment;
  /** ISO timestamp when the summary was produced. */
  generatedAt: string;
  /** Provider + model name used for this summary. */
  generatedBy: string;
}

export interface SessionTag {
  id: string;
  label: string;
  color?: SpeakerColor;
}

export interface Session {
  id: string;
  title: string;
  /** ISO timestamp of when the recording started. */
  createdAt: string;
  durationMs: number;
  language: string;
  modelId: WhisperModelId;
  tags: SessionTag[];
  starred: boolean;
  /** Always sorted by startMs ascending. */
  segments: TranscriptionSegment[];
  speakers: Speaker[];
  summary?: SessionSummary;
  actionItems: ActionItem[];
  chapters: Chapter[];
}
