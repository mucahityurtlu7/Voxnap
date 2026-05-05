/**
 * LanguageStep — pick the spoken language + optional translation.
 *
 * The list mirrors the one in SettingsPage so the wizard and post-setup
 * UX feel like one product. "Auto-detect" is the default — Whisper does a
 * surprisingly good job of identifying the language from the first few
 * seconds of audio.
 */
import clsx from "clsx";
import { Globe2, Languages } from "lucide-react";

import { Toggle } from "../../components/ui/Toggle.js";

const LANGUAGES: { code: string; label: string; native: string }[] = [
  { code: "auto", label: "Auto-detect", native: "Whisper guesses for you" },
  { code: "en", label: "English", native: "English" },
  { code: "tr", label: "Turkish", native: "Türkçe" },
  { code: "de", label: "German", native: "Deutsch" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "fr", label: "French", native: "Français" },
  { code: "it", label: "Italian", native: "Italiano" },
  { code: "ja", label: "Japanese", native: "日本語" },
  { code: "zh", label: "Chinese", native: "中文" },
];

export interface LanguageStepProps {
  language: string;
  onLanguageChange: (lang: string) => void;
  translate: boolean;
  onTranslateChange: (v: boolean) => void;
}

export function LanguageStep({
  language,
  onLanguageChange,
  translate,
  onTranslateChange,
}: LanguageStepProps) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
          <Languages className="h-3.5 w-3.5 text-muted" />
          Spoken language
        </div>
        <div
          role="radiogroup"
          aria-label="Spoken language"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {LANGUAGES.map((l) => {
            const selected = language === l.code;
            return (
              <button
                key={l.code}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onLanguageChange(l.code)}
                className={clsx(
                  "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left outline-none transition-all duration-150",
                  "focus-visible:ring-2 focus-visible:ring-brand-500/40",
                  selected
                    ? "border-brand-500 bg-brand-gradient-soft shadow-glow"
                    : "border-border bg-surface-2 hover:border-brand-500/40",
                )}
              >
                <span className="text-sm font-medium text-text">
                  {l.code === "auto" ? (
                    <span className="inline-flex items-center gap-1">
                      <Globe2 className="h-3.5 w-3.5" />
                      {l.label}
                    </span>
                  ) : (
                    l.label
                  )}
                </span>
                <span className="text-[11px] text-muted">{l.native}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Toggle
        checked={translate}
        onChange={onTranslateChange}
        label="Translate to English"
        description="Whisper transcribes the speech and outputs an English translation in real-time."
      />
    </div>
  );
}
