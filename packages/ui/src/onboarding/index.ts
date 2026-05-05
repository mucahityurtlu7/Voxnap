/**
 * @voxnap/ui — onboarding barrel.
 *
 * Apps usually only need `OnboardingPage`; the rest is exported for
 * advanced embedding (e.g. swapping a single step in a custom shell).
 */
export { OnboardingPage } from "./OnboardingPage.js";
export { OnboardingShell } from "./OnboardingShell.js";
export type { OnboardingShellProps } from "./OnboardingShell.js";
export { ProgressDots } from "./ProgressDots.js";
export type { ProgressDotsProps } from "./ProgressDots.js";

export { WelcomeStep } from "./steps/WelcomeStep.js";
export { ThemeStep } from "./steps/ThemeStep.js";
export { MicrophoneStep } from "./steps/MicrophoneStep.js";
export { ModelStep } from "./steps/ModelStep.js";
export { LanguageStep } from "./steps/LanguageStep.js";
export { AiStep, isAiStepValid } from "./steps/AiStep.js";
export { DoneStep } from "./steps/DoneStep.js";
