/**
 * ThemeStep — light / dark / system picker.
 *
 * Applies the chosen theme immediately via `useTheme().setMode` so the
 * user sees the change while the rest of the wizard continues. The choice
 * is also mirrored into the onboarding store for the recap on the
 * "All set" page.
 */
import clsx from "clsx";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect } from "react";

import { useTheme, type ThemeMode } from "../../hooks/useTheme.js";
import type { OnboardingTheme } from "@voxnap/core";

const OPTIONS: {
  value: OnboardingTheme;
  label: string;
  description: string;
  icon: typeof Sun;
}[] = [
  {
    value: "system",
    label: "System",
    description: "Match your operating system.",
    icon: Monitor,
  },
  {
    value: "light",
    label: "Light",
    description: "Bright surfaces, soft shadows.",
    icon: Sun,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Low-light friendly, deep slate.",
    icon: Moon,
  },
];

export interface ThemeStepProps {
  value: OnboardingTheme;
  onChange: (mode: OnboardingTheme) => void;
}

export function ThemeStep({ value, onChange }: ThemeStepProps) {
  const { mode, setMode } = useTheme();

  // Sync the global theme with whatever the wizard has stored.
  useEffect(() => {
    if (mode !== value) setMode(value as ThemeMode);
    // We intentionally only run this when the wizard's stored value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handlePick = (m: OnboardingTheme) => {
    onChange(m);
    setMode(m as ThemeMode);
  };

  return (
    <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => handlePick(opt.value)}
            className={clsx(
              "group flex flex-col items-stretch gap-3 rounded-xl border p-4 text-left outline-none transition-all duration-200",
              "focus-visible:ring-2 focus-visible:ring-brand-500/40",
              selected
                ? "border-brand-500 bg-brand-gradient-soft shadow-glow"
                : "border-border bg-surface-2 hover:border-brand-500/40",
            )}
          >
            <ThemePreview mode={opt.value} />
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-text">
                  <Icon className="h-3.5 w-3.5" />
                  {opt.label}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {opt.description}
                </div>
              </div>
              <span
                aria-hidden
                className={clsx(
                  "h-3 w-3 rounded-full border transition-colors",
                  selected
                    ? "border-brand-500 bg-brand-500"
                    : "border-border-strong bg-transparent group-hover:border-brand-500/60",
                )}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Tiny inline preview rectangle so users can see what they're picking. */
function ThemePreview({ mode }: { mode: OnboardingTheme }) {
  if (mode === "system") {
    return (
      <div className="grid h-20 grid-cols-2 overflow-hidden rounded-lg border border-border">
        <PreviewBlock dark={false} />
        <PreviewBlock dark />
      </div>
    );
  }
  return (
    <div className="h-20 overflow-hidden rounded-lg border border-border">
      <PreviewBlock dark={mode === "dark"} />
    </div>
  );
}

function PreviewBlock({ dark }: { dark: boolean }) {
  return (
    <div
      className={clsx(
        "flex h-full w-full flex-col gap-1.5 p-2",
        dark ? "bg-zinc-900" : "bg-zinc-50",
      )}
    >
      <div
        className={clsx(
          "h-1.5 w-10 rounded-full",
          dark ? "bg-zinc-700" : "bg-zinc-300",
        )}
      />
      <div
        className={clsx(
          "h-1.5 w-14 rounded-full",
          dark ? "bg-zinc-700/70" : "bg-zinc-300/70",
        )}
      />
      <div
        className={clsx(
          "mt-auto h-2 w-8 rounded-full",
          "bg-gradient-to-r from-brand-500 to-fuchsia-400",
        )}
      />
    </div>
  );
}
