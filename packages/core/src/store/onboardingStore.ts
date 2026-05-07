/**
 * Onboarding store — first-run setup wizard state.
 *
 * Tracks whether the user has completed (or skipped) the welcome flow,
 * which step they are on, and the choices they have made so far so the
 * wizard can be resumed later or replayed from Settings → About.
 *
 * Persisted to localStorage where available so a refresh doesn't kick the
 * user back to step 1, and so the App shell knows on next launch whether
 * to mount the wizard or jump straight into the regular UI.
 *
 * The store is intentionally framework-agnostic (no React, no Tauri) —
 * it just describes the user's preferences. Engines and UI providers
 * read these values when bootstrapping.
 */
import { create } from "zustand";

import {
  AI_PROVIDERS,
  DEFAULT_MODEL,
  WHISPER_MODELS,
  type AiProvider,
  type ComputeBackend,
  type SummaryLength,
  type WhisperModelId,
} from "../types.js";


/** Names of every step in the wizard, in display order. */
export const ONBOARDING_STEPS = [
  "welcome",
  "theme",
  "microphone",
  "model",
  "compute",
  "language",
  "ai",
  "done",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingTheme = "system" | "light" | "dark";

export interface OnboardingChoices {
  theme: OnboardingTheme;
  /** Selected input device id; empty string == default device. */
  micDeviceId: string;
  /** Whether the wizard saw a non-zero level from the chosen mic. */
  micVerified: boolean;
  modelId: WhisperModelId;
  /** ISO 639-1 code or "auto". */
  language: string;
  translateToEnglish: boolean;
  /** VAD RMS threshold passed to the engine. 0.0 means always-run. Default 0.012. */
  vadThreshold: number;
  /** Whether energy-based VAD is enabled. Default true. */
  vadEnabled: boolean;
  /**
   * Where the model should run. `"auto"` lets the engine pick the best
   * available accelerator (NPU > GPU > CPU). Default `"auto"`.
   */
  computeBackend: ComputeBackend;
  aiProvider: AiProvider;
  /** Stored locally only when the chosen provider needs a key. */
  aiApiKey: string;
  summaryLength: SummaryLength;
}

export interface OnboardingState extends OnboardingChoices {
  /** True once the user clicks "Open Voxnap" on the final step. */
  completed: boolean;
  /** Currently displayed step. Persisted so refresh resumes in place. */
  step: OnboardingStep;

  // ---- navigation ------------------------------------------------------
  goTo: (step: OnboardingStep) => void;
  next: () => void;
  prev: () => void;
  finish: () => void;
  reset: () => void;

  // ---- choice setters --------------------------------------------------
  setTheme: (t: OnboardingTheme) => void;
  setMicDeviceId: (id: string) => void;
  setMicVerified: (verified: boolean) => void;
  setModelId: (id: WhisperModelId) => void;
  setLanguage: (lang: string) => void;
  setTranslateToEnglish: (v: boolean) => void;
  setVadThreshold: (v: number) => void;
  setVadEnabled: (v: boolean) => void;
  setAiProvider: (p: AiProvider) => void;
  setAiApiKey: (key: string) => void;
  setSummaryLength: (l: SummaryLength) => void;
  setComputeBackend: (b: ComputeBackend) => void;
}

const STORAGE_KEY = "voxnap.onboarding.v1";

const DEFAULTS: OnboardingChoices & {
  completed: boolean;
  step: OnboardingStep;
} = {
  completed: false,
  step: "welcome",
  theme: "system",
  micDeviceId: "",
  micVerified: false,
  modelId: DEFAULT_MODEL,
  language: "auto",
  translateToEnglish: false,
  vadThreshold: 0.012,
  vadEnabled: true,
  computeBackend: "auto",
  aiProvider: "mock",
  aiApiKey: "",
  summaryLength: "medium",
};

function readState(): OnboardingChoices & {
  completed: boolean;
  step: OnboardingStep;
} {
  if (typeof globalThis === "undefined") return { ...DEFAULTS };
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return { ...DEFAULTS };
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    // Hardening: if the persisted provider is no longer recognised
    // (e.g. we removed it in a future version), fall back to the default.
    const provider =
      parsed.aiProvider && parsed.aiProvider in AI_PROVIDERS
        ? parsed.aiProvider
        : DEFAULTS.aiProvider;
    const step = (ONBOARDING_STEPS as readonly string[]).includes(
      parsed.step ?? "",
    )
      ? (parsed.step as OnboardingStep)
      : DEFAULTS.step;
    // Hardening: any older build (or hand-edited storage) might persist a
    // compute backend that is no longer in the union; fall back to "auto".
    const computeBackend: ComputeBackend =
      parsed.computeBackend === "auto" ||
      parsed.computeBackend === "cpu" ||
      parsed.computeBackend === "gpu" ||
      parsed.computeBackend === "npu"
        ? parsed.computeBackend
        : DEFAULTS.computeBackend;
    // Hardening: an older build may have persisted a model id we no longer
    // recognise (e.g. the bogus `medium.q5_1` that doesn't exist on HF).
    // Fall back to DEFAULT_MODEL so the engine doesn't immediately fail
    // with `model-not-found` on the next launch.
    const modelId =
      parsed.modelId && parsed.modelId in WHISPER_MODELS
        ? (parsed.modelId as WhisperModelId)
        : DEFAULTS.modelId;
    return {
      ...DEFAULTS,
      ...parsed,
      aiProvider: provider,
      step,
      modelId,
      computeBackend,
    };

  } catch {
    return { ...DEFAULTS };
  }
}

function writeState(snapshot: Partial<OnboardingState>): void {
  if (typeof globalThis === "undefined") return;
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return;
  try {
    // Only persist serialisable, value-shaped fields — never functions.
    const {
      completed,
      step,
      theme,
      micDeviceId,
      micVerified,
      modelId,
      language,
      translateToEnglish,
      vadThreshold,
      vadEnabled,
      computeBackend,
      aiProvider,
      aiApiKey,
      summaryLength,
    } = snapshot;
    ls.setItem(
      STORAGE_KEY,
      JSON.stringify({
        completed,
        step,
        theme,
        micDeviceId,
        micVerified,
        modelId,
        language,
        translateToEnglish,
        vadThreshold,
        vadEnabled,
        computeBackend,
        aiProvider,
        aiApiKey,
        summaryLength,
      }),
    );
  } catch {
    /* ignore — quota, private mode, etc. */
  }
}

function indexOfStep(step: OnboardingStep): number {
  return (ONBOARDING_STEPS as readonly string[]).indexOf(step);
}

export const useOnboardingStore = create<OnboardingState>((set, get) => {
  const persistAfter = (mutator: () => void) => {
    mutator();
    writeState(get());
  };

  return {
    ...readState(),

    goTo: (step) =>
      persistAfter(() => {
        set({ step });
      }),

    next: () =>
      persistAfter(() => {
        const i = indexOfStep(get().step);
        const last = ONBOARDING_STEPS.length - 1;
        const nextStep = ONBOARDING_STEPS[Math.min(i + 1, last)]!;
        set({ step: nextStep });
      }),

    prev: () =>
      persistAfter(() => {
        const i = indexOfStep(get().step);
        const prevStep = ONBOARDING_STEPS[Math.max(i - 1, 0)]!;
        set({ step: prevStep });
      }),

    finish: () =>
      persistAfter(() => {
        set({ completed: true, step: "done" });
      }),

    reset: () =>
      persistAfter(() => {
        set({ ...DEFAULTS });
      }),

    setTheme: (theme) =>
      persistAfter(() => {
        set({ theme });
      }),

    setMicDeviceId: (micDeviceId) =>
      persistAfter(() => {
        set({ micDeviceId });
      }),

    setMicVerified: (micVerified) =>
      persistAfter(() => {
        set({ micVerified });
      }),

    setModelId: (modelId) =>
      persistAfter(() => {
        set({ modelId });
      }),

    setLanguage: (language) =>
      persistAfter(() => {
        set({ language });
      }),

    setTranslateToEnglish: (translateToEnglish) =>
      persistAfter(() => {
        set({ translateToEnglish });
      }),

    setAiProvider: (aiProvider) =>
      persistAfter(() => {
        set({ aiProvider });
      }),

    setAiApiKey: (aiApiKey) =>
      persistAfter(() => {
        set({ aiApiKey });
      }),

    setVadThreshold: (vadThreshold) =>
      persistAfter(() => {
        set({ vadThreshold });
      }),

    setVadEnabled: (vadEnabled) =>
      persistAfter(() => {
        set({ vadEnabled });
      }),

    setSummaryLength: (summaryLength) =>
      persistAfter(() => {
        set({ summaryLength });
      }),

    setComputeBackend: (computeBackend) =>
      persistAfter(() => {
        set({ computeBackend });
      }),
  };
});

/** True if the user has finished (or skipped through) onboarding. */
export function hasCompletedOnboarding(): boolean {
  return readState().completed;
}
