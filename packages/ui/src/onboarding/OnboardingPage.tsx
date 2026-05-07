/**
 * OnboardingPage — the root component of the first-run setup wizard.
 *
 * Wires the onboarding store to the right step component and the
 * shared `OnboardingShell`. Persists every choice automatically so
 * a refresh resumes the user in place; calling `finish()` flips
 * `completed` to true and the App swaps over to the regular shell.
 *
 * Usage (already handled by `App.tsx`):
 *
 *   const { completed } = useOnboarding();
 *   if (!completed) return <OnboardingPage />;
 *   return <AppShell>...</AppShell>;
 */
import { type ReactNode } from "react";
import { Sparkles, Mic, Cpu, Palette, Languages, Zap } from "lucide-react";
import {
  useAiStore,
  type AiProvider,
  type OnboardingStep,
  type SummaryLength,
} from "@voxnap/core";

import { OnboardingShell } from "./OnboardingShell.js";
import { useOnboarding } from "../hooks/useOnboarding.js";
import { WelcomeStep } from "./steps/WelcomeStep.js";
import { ThemeStep } from "./steps/ThemeStep.js";
import { MicrophoneStep } from "./steps/MicrophoneStep.js";
import { ModelStep } from "./steps/ModelStep.js";
import { ComputeStep } from "./steps/ComputeStep.js";
import { LanguageStep } from "./steps/LanguageStep.js";
import { AiStep, isAiStepValid } from "./steps/AiStep.js";
import { DoneStep } from "./steps/DoneStep.js";

interface StepMeta {
  eyebrow: { label: string; icon: typeof Sparkles };
  title: ReactNode;
  description?: string;
  /** Skip means: keep choices but don't enforce validation, just go forward. */
  skippable?: boolean;
}

const STEP_META: Record<OnboardingStep, StepMeta> = {
  welcome: {
    eyebrow: { label: "Welcome", icon: Sparkles },
    title: (
      <>
        Welcome to <span className="vx-gradient-text">Voxnap</span>
      </>
    ),
    description:
      "Live transcription that respects your privacy and runs the same on every device. Let's set things up — it'll take a minute.",
  },
  theme: {
    eyebrow: { label: "Appearance", icon: Palette },
    title: "How should Voxnap look?",
    description:
      "You can switch any time from Settings; pick what feels right now.",
  },
  microphone: {
    eyebrow: { label: "Microphone", icon: Mic },
    title: "Set up your microphone",
    description:
      "We'll request access and run a quick level test so you know recording is going to work.",
    skippable: true,
  },
  model: {
    eyebrow: { label: "Whisper model", icon: Cpu },
    title: "Pick a Whisper model",
    description:
      "Smaller models are faster and lighter; larger ones are more accurate. Base is a great default.",
  },
  compute: {
    eyebrow: { label: "Compute", icon: Zap },
    title: (
      <>
        Where should models <span className="vx-gradient-text">run</span>?
      </>
    ),
    description:
      "Voxnap auto-detects compute accelerators on your device. NPUs and GPUs run language models faster and use less battery than the CPU.",
    skippable: true,
  },
  language: {
    eyebrow: { label: "Language", icon: Languages },
    title: "Which language will you speak?",
    description:
      "Auto-detect handles most situations. Pin a language for noisier rooms or unusual accents.",
  },
  ai: {
    eyebrow: { label: "AI assistant", icon: Sparkles },
    title: "Add some AI super-powers",
    description:
      "Voxnap can summarise, extract action items and answer questions about your transcripts. You can skip and configure this later.",
    skippable: true,
  },
  done: {
    eyebrow: { label: "All set", icon: Sparkles },
    title: "You're ready to record",
  },
};

export function OnboardingPage() {
  const onb = useOnboarding();
  const meta = STEP_META[onb.step];
  const Eyebrow = meta.eyebrow.icon;

  // The AI store mirrors what the wizard collects — keep them in sync as
  // the user makes choices so the rest of the app sees a consistent
  // configuration the moment they hit "Open Voxnap".
  const setStoreProvider = useAiStore((s) => s.setProvider);
  const setStoreApiKey = useAiStore((s) => s.setApiKey);
  const setStoreSummaryLength = useAiStore((s) => s.setSummaryLength);

  const handleProvider = (p: AiProvider) => {
    onb.setAiProvider(p);
    setStoreProvider(p);
  };
  const handleApiKey = (k: string) => {
    onb.setAiApiKey(k);
    setStoreApiKey(k);
  };
  const handleSummaryLength = (l: SummaryLength) => {
    onb.setSummaryLength(l);
    setStoreSummaryLength(l);
  };

  const handleFinish = () => {
    // Final commit to the AI store, so anything still in flight gets saved.
    setStoreProvider(onb.choices.aiProvider);
    setStoreApiKey(onb.choices.aiApiKey);
    setStoreSummaryLength(onb.choices.summaryLength);
    onb.finish();
  };

  // ---- per-step body + nav config -----------------------------------
  let body: ReactNode = null;
  let nextDisabled = false;
  let onSkip: (() => void) | undefined;

  switch (onb.step) {
    case "welcome":
      body = <WelcomeStep />;
      break;
    case "theme":
      body = (
        <ThemeStep value={onb.choices.theme} onChange={onb.setTheme} />
      );
      break;
    case "microphone":
      body = (
        <MicrophoneStep
          deviceId={onb.choices.micDeviceId}
          onDeviceChange={onb.setMicDeviceId}
          verified={onb.choices.micVerified}
          onVerifiedChange={onb.setMicVerified}
        />
      );
      onSkip = onb.next;
      break;
    case "model":
      body = (
        <ModelStep
          value={onb.choices.modelId}
          onChange={onb.setModelId}
        />
      );
      break;
    case "compute":
      body = (
        <ComputeStep
          value={onb.choices.computeBackend}
          onChange={onb.setComputeBackend}
        />
      );
      onSkip = onb.next;
      break;
    case "language":
      body = (
        <LanguageStep
          language={onb.choices.language}
          onLanguageChange={onb.setLanguage}
          translate={onb.choices.translateToEnglish}
          onTranslateChange={onb.setTranslateToEnglish}
        />
      );
      break;
    case "ai":
      body = (
        <AiStep
          provider={onb.choices.aiProvider}
          onProviderChange={handleProvider}
          apiKey={onb.choices.aiApiKey}
          onApiKeyChange={handleApiKey}
          summaryLength={onb.choices.summaryLength}
          onSummaryLengthChange={handleSummaryLength}
        />
      );
      nextDisabled = !isAiStepValid(
        onb.choices.aiProvider,
        onb.choices.aiApiKey,
      );
      onSkip = onb.next;
      break;
    case "done":
      body = (
        <DoneStep
          theme={onb.choices.theme}
          micVerified={onb.choices.micVerified}
          modelId={onb.choices.modelId}
          language={onb.choices.language}
          translate={onb.choices.translateToEnglish}
          computeBackend={onb.choices.computeBackend}
          aiProvider={onb.choices.aiProvider}
          summaryLength={onb.choices.summaryLength}
          onFinish={handleFinish}
        />
      );
      break;
  }

  const isDone = onb.step === "done";
  const nextLabel =
    onb.step === "welcome"
      ? "Get started"
      : onb.step === "ai"
        ? "Continue"
        : "Continue";

  return (
    <OnboardingShell
      eyebrow={
        <>
          <Eyebrow className="h-3 w-3" />
          <span>
            Step {onb.stepIndex + 1} of {onb.totalSteps - 1} ·{" "}
            {meta.eyebrow.label}
          </span>
        </>
      }
      title={meta.title}
      description={meta.description}
      stepIndex={onb.stepIndex}
      totalSteps={onb.totalSteps}
      onBack={onb.isFirst ? undefined : onb.prev}
      onNext={isDone ? undefined : onb.next}
      onSkip={meta.skippable ? onSkip : undefined}
      nextLabel={nextLabel}
      nextDisabled={nextDisabled}
      onJump={(i) => {
        // Only allow jumping to a step that's already been visited.
        if (i <= onb.stepIndex) {
          onb.goTo(
            (
              [
                "welcome",
                "theme",
                "microphone",
                "model",
                "compute",
                "language",
                "ai",
                "done",
              ] as const
            )[i]!,
          );
        }
      }}
      footerLeft={
        nextDisabled ? (
          <span className="text-rose-500">
            Add an API key to continue, or skip for now.
          </span>
        ) : null
      }
    >
      {body}
    </OnboardingShell>
  );
}
