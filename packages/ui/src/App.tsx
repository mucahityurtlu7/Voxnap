/**
 * App — Voxnap's top-level React tree.
 *
 * Mounts the router + AppShell and registers every page route.
 *
 * Apps inject the engine + summariser + session store via providers
 * around <App /> in their main.tsx, so the shell stays platform-agnostic.
 */
import { useState, useEffect, useCallback } from "react";
import { Route, Routes, BrowserRouter, HashRouter } from "react-router-dom";
import {
  DEFAULT_MODEL,
  useOnboardingStore,
  useTranscriptionStore,
  type WhisperModelId,
} from "@voxnap/core";

import { AppShell } from "./layout/AppShell.js";
import { LiveTranscribePage } from "./pages/LiveTranscribePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SessionsPage } from "./pages/SessionsPage.js";
import { SessionDetailPage } from "./pages/SessionDetailPage.js";
import { SummariesPage } from "./pages/SummariesPage.js";
import { InsightsPage } from "./pages/InsightsPage.js";
import { ensureThemeApplied } from "./hooks/useTheme.js";
import { useEngine } from "./engine/EngineProvider.js";
import { useOnboarding } from "./hooks/useOnboarding.js";
import { OnboardingPage } from "./onboarding/OnboardingPage.js";

export interface AppProps {
  /**
   * Tauri loads files via the `tauri://` protocol with no real URL paths.
   * Native shells should pass `router="hash"`; the web build uses `"browser"`.
   */
  router?: "browser" | "hash";
}

export function App({ router = "browser" }: AppProps) {
  // Ensure the saved theme is applied before first paint.
  useEffect(() => {
    ensureThemeApplied();
  }, []);

  const Router = router === "hash" ? HashRouter : BrowserRouter;
  return (
    <Router>
      <Shell />
    </Router>
  );
}

function Shell() {
  const onboarding = useOnboarding();

  const [modelId, setModelIdLocal] = useState<WhisperModelId>(
    onboarding.choices.modelId ?? DEFAULT_MODEL,
  );
  const [language, setLanguageLocal] = useState<string>(
    onboarding.choices.language ?? "auto",
  );
  const [translate, setTranslateLocal] = useState<boolean>(
    onboarding.choices.translateToEnglish ?? false,
  );
  const [vadThreshold, setVadThresholdLocal] = useState<number>(
    onboarding.choices.vadThreshold ?? 0.012,
  );
  const [vadEnabled, setVadEnabledLocal] = useState<boolean>(
    onboarding.choices.vadEnabled ?? true,
  );
  const engine = useEngine();
  const engineState = useTranscriptionStore((s) => s.engineState);

  // Persist user's runtime model/language/translate choices back into the
  // onboarding store so the picks survive across reloads and the engine
  // re-init effect in <LiveTranscribePage /> picks them up consistently.
  const setModelId = useCallback((id: WhisperModelId) => {
    setModelIdLocal(id);
    useOnboardingStore.getState().setModelId(id);
  }, []);
  const setLanguage = useCallback((lang: string) => {
    setLanguageLocal(lang);
    useOnboardingStore.getState().setLanguage(lang);
  }, []);
  const setTranslate = useCallback((v: boolean) => {
    setTranslateLocal(v);
    useOnboardingStore.getState().setTranslateToEnglish(v);
  }, []);
  const setVadThreshold = useCallback((v: number) => {
    setVadThresholdLocal(v);
    useOnboardingStore.getState().setVadThreshold(v);
  }, []);
  const setVadEnabled = useCallback((v: boolean) => {
    setVadEnabledLocal(v);
    useOnboardingStore.getState().setVadEnabled(v);
  }, []);

  // Once the user finishes onboarding, hydrate the live config with their
  // picks so the first recording uses the model + language they chose.
  useEffect(() => {
    if (onboarding.completed) {
      setModelIdLocal(onboarding.choices.modelId);
      setLanguageLocal(onboarding.choices.language);
      setTranslateLocal(onboarding.choices.translateToEnglish);
      setVadThresholdLocal(onboarding.choices.vadThreshold);
      setVadEnabledLocal(onboarding.choices.vadEnabled);
    }
  }, [
    onboarding.completed,
    onboarding.choices.modelId,
    onboarding.choices.language,
    onboarding.choices.translateToEnglish,
    onboarding.choices.vadThreshold,
    onboarding.choices.vadEnabled,
  ]);

  // Until the user has finished the welcome wizard, render it instead of
  // the regular AppShell. This keeps the first-run experience focused and
  // avoids confusing them with sidebars + empty pages.
  if (!onboarding.completed) {
    return <OnboardingPage />;
  }

  const onToggleRecording = () => {
    if (engineState === "running") void engine.stop();
    else void engine.start();
  };

  return (
    <AppShell
      modelId={modelId}
      onModelChange={setModelId}
      language={language}
      onLanguageChange={setLanguage}
      engineState={engineState}
      onToggleRecording={onToggleRecording}
    >
      <Routes>
        <Route
          path="/"
          element={
            <LiveTranscribePage
              modelId={modelId}
              language={language}
              translate={translate}
              vadThreshold={vadThreshold}
              vadEnabled={vadEnabled}
            />
          }
        />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/summaries" element={<SummariesPage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route
          path="/settings"
          element={
            <SettingsPage
              modelId={modelId}
              onModelChange={setModelId}
              language={language}
              onLanguageChange={setLanguage}
              translate={translate}
              onTranslateChange={setTranslate}
            />
          }
        />
      </Routes>
    </AppShell>
  );
}
