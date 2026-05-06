/**
 * useOnboarding — thin React hook around the @voxnap/core onboarding store.
 *
 * Exposes:
 *   • `completed`           — has the user finished the wizard at least once?
 *   • `step`, `stepIndex`   — current step + its 0-based position
 *   • `totalSteps`          — for progress bars
 *   • `next` / `prev` / `goTo` / `finish` / `reset`
 *   • `choices`             — every value the user has picked so far
 *   • setters mirroring those choices
 *
 * Components should generally talk to this hook instead of importing the
 * raw zustand store, so we can swap the backing store later without
 * rippling through every step component.
 */
import { useCallback } from "react";
import {
  ONBOARDING_STEPS,
  useOnboardingStore,
  type AiProvider,
  type OnboardingStep,
  type OnboardingTheme,
  type SummaryLength,
  type WhisperModelId,
} from "@voxnap/core";

export interface UseOnboardingApi {
  completed: boolean;
  step: OnboardingStep;
  stepIndex: number;
  totalSteps: number;
  isFirst: boolean;
  isLast: boolean;

  next: () => void;
  prev: () => void;
  goTo: (step: OnboardingStep) => void;
  finish: () => void;
  reset: () => void;

  choices: {
    theme: OnboardingTheme;
    micDeviceId: string;
    micVerified: boolean;
    modelId: WhisperModelId;
    language: string;
    translateToEnglish: boolean;
    vadThreshold: number;
    vadEnabled: boolean;
    aiProvider: AiProvider;
    aiApiKey: string;
    summaryLength: SummaryLength;
  };

  setTheme: (t: OnboardingTheme) => void;
  setMicDeviceId: (id: string) => void;
  setMicVerified: (v: boolean) => void;
  setModelId: (id: WhisperModelId) => void;
  setLanguage: (lang: string) => void;
  setTranslateToEnglish: (v: boolean) => void;
  setAiProvider: (p: AiProvider) => void;
  setAiApiKey: (k: string) => void;
  setSummaryLength: (l: SummaryLength) => void;
}

export function useOnboarding(): UseOnboardingApi {
  const completed = useOnboardingStore((s) => s.completed);
  const step = useOnboardingStore((s) => s.step);

  const next = useOnboardingStore((s) => s.next);
  const prev = useOnboardingStore((s) => s.prev);
  const goTo = useOnboardingStore((s) => s.goTo);
  const finish = useOnboardingStore((s) => s.finish);
  const reset = useOnboardingStore((s) => s.reset);

  const theme = useOnboardingStore((s) => s.theme);
  const micDeviceId = useOnboardingStore((s) => s.micDeviceId);
  const micVerified = useOnboardingStore((s) => s.micVerified);
  const modelId = useOnboardingStore((s) => s.modelId);
  const language = useOnboardingStore((s) => s.language);
  const translateToEnglish = useOnboardingStore((s) => s.translateToEnglish);
  const vadThreshold = useOnboardingStore((s) => s.vadThreshold);
  const vadEnabled = useOnboardingStore((s) => s.vadEnabled);
  const aiProvider = useOnboardingStore((s) => s.aiProvider);
  const aiApiKey = useOnboardingStore((s) => s.aiApiKey);
  const summaryLength = useOnboardingStore((s) => s.summaryLength);

  const setTheme = useOnboardingStore((s) => s.setTheme);
  const setMicDeviceId = useOnboardingStore((s) => s.setMicDeviceId);
  const setMicVerified = useOnboardingStore((s) => s.setMicVerified);
  const setModelId = useOnboardingStore((s) => s.setModelId);
  const setLanguage = useOnboardingStore((s) => s.setLanguage);
  const setTranslateToEnglish = useOnboardingStore(
    (s) => s.setTranslateToEnglish,
  );
  const setAiProvider = useOnboardingStore((s) => s.setAiProvider);
  const setAiApiKey = useOnboardingStore((s) => s.setAiApiKey);
  const setSummaryLength = useOnboardingStore((s) => s.setSummaryLength);

  const stepIndex = ONBOARDING_STEPS.indexOf(step);
  const totalSteps = ONBOARDING_STEPS.length;

  // Stable wrappers in case React strict-mode re-runs the effect; the
  // underlying store is already memoised by zustand.
  const stableNext = useCallback(next, [next]);
  const stablePrev = useCallback(prev, [prev]);

  return {
    completed,
    step,
    stepIndex,
    totalSteps,
    isFirst: stepIndex <= 0,
    isLast: stepIndex >= totalSteps - 1,

    next: stableNext,
    prev: stablePrev,
    goTo,
    finish,
    reset,

    choices: {
      theme,
      micDeviceId,
      micVerified,
      modelId,
      language,
      translateToEnglish,
      vadThreshold,
      vadEnabled,
      aiProvider,
      aiApiKey,
      summaryLength,
    },

    setTheme,
    setMicDeviceId,
    setMicVerified,
    setModelId,
    setLanguage,
    setTranslateToEnglish,
    setAiProvider,
    setAiApiKey,
    setSummaryLength,
  };
}
