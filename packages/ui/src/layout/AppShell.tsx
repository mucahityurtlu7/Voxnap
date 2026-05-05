/**
 * AppShell — the global layout wrapping every page.
 *
 * Responsibilities:
 *   • render Sidebar (lg+) / BottomTabs (mobile)
 *   • render Topbar with search + model/language pills + theme toggle
 *   • host the CommandPalette and global keyboard shortcuts
 *   • mount the toast viewport
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  type EngineState,
  type WhisperModelId,
  useTranscriptionStore,
} from "@voxnap/core";

import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";
import { BottomTabs } from "./BottomTabs.js";
import { CommandPalette } from "./CommandPalette.js";
import { useShortcuts } from "../hooks/useShortcuts.js";
import { useTheme } from "../hooks/useTheme.js";
import { ToastViewport } from "../components/ui/Toast.js";

export interface AppShellProps {
  modelId: WhisperModelId;
  onModelChange: (id: WhisperModelId) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  /** Engine state used to render the sidebar status pill. */
  engineState?: EngineState;
  children: ReactNode;
  /** Hooked up to the palette's "Start/Stop recording" entry. */
  onToggleRecording?: () => void;
}

export function AppShell({
  modelId,
  onModelChange,
  language,
  onLanguageChange,
  engineState = "idle",
  children,
  onToggleRecording,
}: AppShellProps) {
  // Keep the theme provider alive so it applies the saved mode.
  useTheme();

  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const recording = useTranscriptionStore((s) => s.engineState === "running");

  useShortcuts([
    {
      keys: "mod+k",
      preventInsideInput: false,
      run: () => setPaletteOpen((o) => !o),
    },
    {
      keys: "mod+,",
      preventInsideInput: true,
      run: () => navigate("/settings"),
    },
    {
      keys: "mod+.",
      preventInsideInput: true,
      run: () => onToggleRecording?.(),
    },
  ]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <Sidebar
        statusLabel={statusLabelFor(engineState)}
        statusTone={statusToneFor(engineState)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          modelId={modelId}
          onModelChange={onModelChange}
          language={language}
          onLanguageChange={onLanguageChange}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>

        <BottomTabs />
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onToggleRecording={onToggleRecording}
        recording={recording}
      />

      <ToastViewport />
    </div>
  );
}

function statusLabelFor(state: EngineState): string {
  switch (state) {
    case "running":
      return "Recording…";
    case "loading-model":
      return "Loading model…";
    case "ready":
      return "Engine ready";
    case "paused":
      return "Paused";
    case "error":
      return "Engine error";
    case "disposed":
      return "Disposed";
    default:
      return "Idle";
  }
}

function statusToneFor(state: EngineState): "ready" | "running" | "loading" | "error" | "idle" {
  switch (state) {
    case "running":
      return "running";
    case "loading-model":
      return "loading";
    case "ready":
      return "ready";
    case "error":
      return "error";
    default:
      return "idle";
  }
}
