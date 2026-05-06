/**
 * @voxnap/ui — public surface.
 *
 * Apps mount the entire app via <App />, or compose individual pages /
 * components if they need a custom layout (e.g. embedded widgets).
 */
export { App } from "./App.js";
export type { AppProps } from "./App.js";

// ---------- providers / boot helpers --------------------------------------
export { EngineProvider, useEngine } from "./engine/EngineProvider.js";
export {
  SummarizerProvider,
  useSummarizer,
} from "./engine/SummarizerProvider.js";
export { SessionsBootstrap } from "./engine/SessionsBootstrap.js";
export {
  ModelManagerProvider,
  useModelManager,
  useOptionalModelManager,
} from "./engine/ModelManagerProvider.js";

// ---------- hooks ---------------------------------------------------------
export { useTranscription } from "./hooks/useTranscription.js";
export type { UseTranscriptionApi } from "./hooks/useTranscription.js";
export { useTheme, ensureThemeApplied } from "./hooks/useTheme.js";
export type { ThemeMode, UseThemeApi } from "./hooks/useTheme.js";
export { useShortcuts, formatShortcut } from "./hooks/useShortcuts.js";
export type { ShortcutBinding } from "./hooks/useShortcuts.js";
export { useSessions, useSession } from "./hooks/useSessions.js";
export { useLiveAi } from "./hooks/useLiveAi.js";
export type { LiveAiState, UseLiveAiOptions } from "./hooks/useLiveAi.js";
export { useOnboarding } from "./hooks/useOnboarding.js";
export type { UseOnboardingApi } from "./hooks/useOnboarding.js";
export { useModels } from "./hooks/useModels.js";
export type { UseModelsApi } from "./hooks/useModels.js";

// ---------- domain components --------------------------------------------
export { MicButton } from "./components/MicButton.js";
export { TranscriptView } from "./components/TranscriptView.js";
export { WaveformBar } from "./components/WaveformBar.js";
export { DeviceSelect } from "./components/DeviceSelect.js";
export { LiveAiPanel } from "./components/LiveAiPanel.js";
export { ModelManagerPanel } from "./components/ModelManagerPanel.js";
export type { ModelManagerPanelProps } from "./components/ModelManagerPanel.js";

// ---------- design system primitives -------------------------------------
export * from "./components/ui/index.js";

// ---------- layout --------------------------------------------------------
export { AppShell } from "./layout/AppShell.js";
export { Sidebar } from "./layout/Sidebar.js";
export { Topbar } from "./layout/Topbar.js";
export { BottomTabs } from "./layout/BottomTabs.js";
export { CommandPalette } from "./layout/CommandPalette.js";

// ---------- pages ---------------------------------------------------------
export { LiveTranscribePage } from "./pages/LiveTranscribePage.js";
export { SettingsPage } from "./pages/SettingsPage.js";
export { SessionsPage } from "./pages/SessionsPage.js";
export { SessionDetailPage } from "./pages/SessionDetailPage.js";
export { SummariesPage } from "./pages/SummariesPage.js";
export { InsightsPage } from "./pages/InsightsPage.js";

// ---------- onboarding wizard --------------------------------------------
export * from "./onboarding/index.js";

// ---------- re-exports for app convenience -------------------------------
export type {
  EngineState,
  EngineConfig,
  EngineError,
  TranscriptionSegment,
  WhisperModelId,
  AudioDevice,
  Session,
  SessionSummary,
  ActionItem,
  Chapter,
  Speaker,
  SpeakerColor,
  Sentiment,
  SummaryLength,
  AiProvider,
  OnboardingStep,
  OnboardingTheme,
  OnboardingChoices,
} from "@voxnap/core";
