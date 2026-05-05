/**
 * Topbar — search, command palette trigger, theme toggle, AI status.
 */
import { useState, type ReactNode } from "react";
import {
  Command,
  Moon,
  Sun,
  Monitor,
  Cpu,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import clsx from "clsx";
import {
  AI_PROVIDERS,
  WHISPER_MODELS,
  useAiStore,
  type WhisperModelId,
} from "@voxnap/core";

import { useTheme } from "../hooks/useTheme.js";
import { Kbd } from "../components/ui/Kbd.js";
import { Tooltip } from "../components/ui/Tooltip.js";

export interface TopbarProps {
  modelId: WhisperModelId;
  onModelChange: (id: WhisperModelId) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  onOpenPalette: () => void;
}

const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto" },
  { code: "en", label: "EN" },
  { code: "tr", label: "TR" },
  { code: "de", label: "DE" },
  { code: "es", label: "ES" },
  { code: "fr", label: "FR" },
  { code: "it", label: "IT" },
  { code: "ja", label: "JA" },
  { code: "zh", label: "ZH" },
];

export function Topbar({
  modelId,
  onModelChange,
  language,
  onLanguageChange,
  onOpenPalette,
}: TopbarProps) {
  const provider = useAiStore((s) => s.provider);
  const providerInfo = AI_PROVIDERS[provider];

  return (
    <header className="safe-top sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/80 px-3 backdrop-blur-md sm:px-5">
      {/* Search / palette trigger */}
      <button
        type="button"
        onClick={onOpenPalette}
        className={clsx(
          "group flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface-2 px-3",
          "text-left text-sm text-muted transition-colors hover:border-brand-500/40 hover:bg-surface-3",
        )}
      >
        <Command className="h-4 w-4" />
        <span className="flex-1 truncate">Search sessions, jump to page, run actions…</span>
        <span className="hidden sm:inline-flex items-center gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <Pill icon={<Cpu className="h-3.5 w-3.5" />}>
          <NativeSelect
            value={modelId}
            onChange={(v) => onModelChange(v as WhisperModelId)}
            options={Object.values(WHISPER_MODELS).map((m) => ({
              value: m.id,
              label: m.label,
            }))}
          />
        </Pill>

        <Pill>
          <NativeSelect
            value={language}
            onChange={onLanguageChange}
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </Pill>

        <Tooltip content={`AI: ${providerInfo.label}`} side="bottom">
          <span
            className={clsx(
              "hidden md:inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium",
              providerInfo.local ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
            )}
          >
            <Sparkles className="h-3 w-3" />
            {providerInfo.local ? "On-device" : "Cloud"}
          </span>
        </Tooltip>

        <ThemeToggle />
      </div>
    </header>
  );
}

function Pill({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex h-8 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 text-xs",
      )}
    >
      {icon && <span className="text-muted">{icon}</span>}
      {children}
    </span>
  );
}

function NativeSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none bg-transparent pr-4 text-xs font-medium text-text outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-muted" />
    </span>
  );
}

function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);

  const Icon = mode === "dark" ? Moon : mode === "light" ? Sun : Monitor;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme"
        title="Theme"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-2 text-muted hover:text-text"
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 z-50 mt-1 w-36 overflow-hidden rounded-lg border border-border bg-surface shadow-soft animate-fade-in">
            {(["system", "light", "dark"] as const).map((m) => {
              const M = m === "dark" ? Moon : m === "light" ? Sun : Monitor;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setOpen(false);
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2 px-3 py-2 text-xs",
                    mode === m
                      ? "bg-surface-3 text-text"
                      : "text-text-subtle hover:bg-surface-3 hover:text-text",
                  )}
                >
                  <M className="h-3.5 w-3.5" />
                  <span className="capitalize">{m}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
