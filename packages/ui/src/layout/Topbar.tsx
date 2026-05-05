/**
 * Topbar — search, command palette trigger, theme toggle, AI status,
 * global recording indicator.
 *
 * Designed to be visually dense but never noisy: every chip uses the same
 * height, border and font scale.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Command,
  Moon,
  Sun,
  Monitor,
  Cpu,
  Sparkles,
  ChevronDown,
  Activity,
} from "lucide-react";
import clsx from "clsx";
import {
  AI_PROVIDERS,
  WHISPER_MODELS,
  useAiStore,
  useTranscriptionStore,
  type WhisperModelId,
} from "@voxnap/core";

import { useTheme } from "../hooks/useTheme.js";
import { Tooltip } from "../components/ui/Tooltip.js";
import { Shortcut } from "../components/ui/Shortcut.js";

export interface TopbarProps {
  modelId: WhisperModelId;
  onModelChange: (id: WhisperModelId) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  onOpenPalette: () => void;
  /** Optional click handler for the global recording pill. */
  onToggleRecording?: () => void;
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
  onToggleRecording,
}: TopbarProps) {
  const provider = useAiStore((s) => s.provider);
  const providerInfo = AI_PROVIDERS[provider];

  return (
    <header className="safe-top sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/80 px-3 backdrop-blur-md sm:px-5">
      {/* Search / palette trigger */}
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        className={clsx(
          "group flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface-2 px-3",
          "text-left text-sm text-muted outline-none transition-colors",
          "hover:border-brand-500/40 hover:bg-surface-3",
          "focus-visible:border-brand-500/60 focus-visible:ring-2 focus-visible:ring-brand-500/20",
        )}
      >
        <Command className="h-4 w-4" aria-hidden />
        <span className="flex-1 truncate">
          <span className="hidden sm:inline">
            Search sessions, jump to page, run actions…
          </span>
          <span className="sm:hidden">Search…</span>
        </span>
        <Shortcut keys="mod+k" className="hidden sm:inline-flex" />
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <RecordingPill onToggleRecording={onToggleRecording} />

        <Pill icon={<Cpu className="h-3.5 w-3.5" aria-hidden />} label="Whisper model">
          <NativeSelect
            ariaLabel="Whisper model"
            value={modelId}
            onChange={(v) => onModelChange(v as WhisperModelId)}
            options={Object.values(WHISPER_MODELS).map((m) => ({
              value: m.id,
              label: m.label,
            }))}
          />
        </Pill>

        <Pill label="Language" className="hidden md:inline-flex">
          <NativeSelect
            ariaLabel="Transcription language"
            value={language}
            onChange={onLanguageChange}
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </Pill>

        <Tooltip content={`AI provider: ${providerInfo.label}`} side="bottom">
          <span
            className={clsx(
              "hidden md:inline-flex h-8 items-center gap-1 rounded-full border px-2 text-[11px] font-medium",
              providerInfo.local
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            )}
          >
            <Sparkles className="h-3 w-3" aria-hidden />
            {providerInfo.local ? "On-device" : "Cloud"}
          </span>
        </Tooltip>

        <ThemeToggle />
      </div>
    </header>
  );
}

function Pill({
  icon,
  children,
  label,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  /** Visually-hidden label that prefixes the pill for screen readers. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-8 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 text-xs",
        "transition-colors focus-within:border-brand-500/60 focus-within:ring-2 focus-within:ring-brand-500/20",
        className,
      )}
    >
      {icon && <span className="text-muted">{icon}</span>}
      {label && <span className="sr-only">{label}</span>}
      {children}
    </span>
  );
}

function NativeSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label={ariaLabel}
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
      <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-muted" aria-hidden />
    </span>
  );
}

/**
 * Tiny live indicator visible on every page when the engine is running.
 *
 * Helps users remember they're still capturing audio after they've
 * navigated away from the Live screen.
 */
function RecordingPill({ onToggleRecording }: { onToggleRecording?: () => void }) {
  const engineState = useTranscriptionStore((s) => s.engineState);
  const isRunning = engineState === "running";
  const isLoading = engineState === "loading-model";

  const startedAtRef = useRef<number | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!isRunning) {
      startedAtRef.current = null;
      return;
    }
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const elapsedLabel = useMemo(() => {
    if (!startedAtRef.current) return "00:00";
    return formatElapsed(Date.now() - startedAtRef.current);
  }, [isRunning, startedAtRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isRunning && !isLoading) return null;

  if (isLoading) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden />
        Loading model…
      </span>
    );
  }

  const Inner = (
    <>
      <span className="relative flex h-2 w-2 items-center justify-center" aria-hidden>
        <span className="absolute h-2 w-2 animate-ping rounded-full bg-rose-500 opacity-75" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-rose-500" />
      </span>
      <Activity className="h-3 w-3" aria-hidden />
      <span className="font-mono tabular-nums">{elapsedLabel}</span>
    </>
  );

  if (onToggleRecording) {
    return (
      <Tooltip content="Stop recording" side="bottom">
        <button
          type="button"
          onClick={onToggleRecording}
          aria-label={`Recording — ${elapsedLabel}. Click to stop.`}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-2.5 text-[11px] font-semibold text-rose-700 outline-none transition-colors hover:bg-rose-500/15 focus-visible:ring-2 focus-visible:ring-rose-500/40 dark:text-rose-300"
        >
          {Inner}
        </button>
      </Tooltip>
    );
  }
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-2.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300"
    >
      {Inner}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const Icon = mode === "dark" ? Moon : mode === "light" ? Sun : Monitor;
  const label = mode === "dark" ? "Dark" : mode === "light" ? "Light" : "System";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus first menu item on open
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitemradio']");
    first?.focus();
  }, [open]);

  const items = ["system", "light", "dark"] as const;
  const onItemKey = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    const all = menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']");
    all?.[next]?.focus();
  };

  return (
    <div className="relative">
      <Tooltip content={`Theme: ${label}`} side="bottom">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Theme: ${label}`}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-2 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      </Tooltip>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Theme"
            className="absolute right-0 z-50 mt-1 w-36 overflow-hidden rounded-lg border border-border bg-surface shadow-soft animate-fade-in"
          >
            {items.map((m, idx) => {
              const M = m === "dark" ? Moon : m === "light" ? Sun : Monitor;
              const checked = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onKeyDown={(e) => onItemKey(e, idx)}
                  onClick={() => {
                    setMode(m);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2 px-3 py-2 text-xs outline-none",
                    checked
                      ? "bg-surface-3 text-text"
                      : "text-text-subtle hover:bg-surface-3 hover:text-text focus-visible:bg-surface-3 focus-visible:text-text",
                  )}
                >
                  <M className="h-3.5 w-3.5" aria-hidden />
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
