/**
 * WelcomeStep — first slide of the onboarding wizard.
 *
 * Sells Voxnap in three lines: privacy-first, multi-platform, AI-powered.
 * No inputs here, just a CTA wired to onNext().
 */
import { Lock, Cpu, Sparkles, Globe2 } from "lucide-react";

const HIGHLIGHTS = [
  {
    icon: Lock,
    title: "Privacy-first",
    description: "Audio + transcripts stay on your device by default.",
  },
  {
    icon: Globe2,
    title: "Runs everywhere",
    description: "Same React UI on desktop, mobile, and the browser.",
  },
  {
    icon: Sparkles,
    title: "AI on tap",
    description: "Optional summaries, action items and chat over your notes.",
  },
];

export function WelcomeStep() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-1">
        {HIGHLIGHTS.map((h) => {
          const Icon = h.icon;
          return (
            <div
              key={h.title}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface-2 p-2.5"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-gradient-soft text-brand-600 dark:text-brand-300">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-text">{h.title}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {h.description}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="rounded-lg border border-border bg-surface-2 p-2.5 text-xs leading-relaxed text-text-subtle">
        Voxnap is built around <Cpu className="mx-1 inline h-3 w-3" />
        whisper.cpp — running on-device with native quality. The next few
        steps will pick a theme, microphone, model and language so your first
        recording feels right.
      </p>
    </div>
  );
}
