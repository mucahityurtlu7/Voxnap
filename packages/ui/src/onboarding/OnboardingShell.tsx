/**
 * OnboardingShell — chrome that wraps every step of the welcome wizard.
 *
 * Provides:
 *   • full-bleed brand background with soft radial glow
 *   • centred frosted card with eyebrow + title + body slots
 *   • sticky footer with Back / Skip / Next buttons + ProgressDots
 *
 * Step components only render the *body*; navigation is controlled here so
 * keyboard handling, button placement and animation stay consistent.
 */
import { type ReactNode, useEffect } from "react";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";

import { Button } from "../components/ui/Button.js";
import { ProgressDots } from "./ProgressDots.js";

export interface OnboardingShellProps {
  /** Small uppercase label above the title — e.g. "Step 2 of 7 · Theme". */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;

  stepIndex: number;
  totalSteps: number;

  /** Hidden when on the first step. */
  onBack?: () => void;
  /** Hidden when undefined (e.g. on Done). */
  onNext?: () => void;
  /** When set, an extra "Skip" button appears between Back and Next. */
  onSkip?: () => void;

  nextLabel?: string;
  skipLabel?: string;
  /** Disable Next while a step is incomplete (e.g. missing API key). */
  nextDisabled?: boolean;

  /** Optional jump-to-step callback wired into ProgressDots. */
  onJump?: (i: number) => void;

  /** Slot rendered to the left of the buttons (e.g. an inline error). */
  footerLeft?: ReactNode;
}

export function OnboardingShell({
  eyebrow,
  title,
  description,
  children,
  stepIndex,
  totalSteps,
  onBack,
  onNext,
  onSkip,
  nextLabel = "Continue",
  skipLabel = "Skip",
  nextDisabled,
  onJump,
  footerLeft,
}: OnboardingShellProps) {
  // Keyboard: Enter advances, Shift+Enter goes back. Esc is intentionally
  // ignored — there's nothing to "close".
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;
      if (inField) return;

      if (e.key === "Enter" && !e.shiftKey && onNext && !nextDisabled) {
        e.preventDefault();
        onNext();
      } else if ((e.key === "Enter" && e.shiftKey) || e.key === "Backspace") {
        if (onBack) {
          e.preventDefault();
          onBack();
        }
      } else if (e.key === "ArrowRight" && (e.metaKey || e.ctrlKey)) {
        if (onNext && !nextDisabled) {
          e.preventDefault();
          onNext();
        }
      } else if (e.key === "ArrowLeft" && (e.metaKey || e.ctrlKey)) {
        if (onBack) {
          e.preventDefault();
          onBack();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onBack, onNext, nextDisabled]);

  return (
    <div className="relative flex h-full min-h-screen w-full flex-col overflow-x-hidden bg-bg text-text">
      {/* Decorative background ----------------------------------------- */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-panel-glow opacity-90"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-1/3 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 bottom-0 h-96 w-96 rounded-full bg-fuchsia-400/20 blur-3xl"
      />

      {/* Top brand row -------------------------------------------------- */}
      <header className="safe-top relative z-10 flex items-center justify-between px-6 py-3 sm:px-10">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient shadow-glow">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <span className="font-display text-base font-semibold tracking-tight">
            <span className="vx-gradient-text">Voxnap</span>
          </span>
        </div>
        <ProgressDots
          total={totalSteps}
          current={stepIndex}
          onJump={onJump}
          className="hidden sm:flex"
        />
      </header>

      {/* Main card ------------------------------------------------------ */}
      <main className="relative z-10 flex flex-1 items-center justify-center overflow-x-hidden px-4 py-3 sm:px-6">
        <div
          key={stepIndex} // re-mount per step → triggers fade-in animation
          className={clsx(
            "vx-panel relative w-full max-w-xl animate-fade-in p-4 sm:p-6",
          )}
        >
          {eyebrow && (
            <div className="vx-eyebrow mb-1.5 flex items-center gap-2">
              {eyebrow}
            </div>
          )}
          <h1 className="font-display text-xl font-semibold tracking-tight text-text sm:text-2xl">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-text-subtle">
              {description}
            </p>
          )}
          <div className="mt-4">{children}</div>
        </div>
      </main>

      {/* Footer --------------------------------------------------------- */}
      <footer className="safe-bottom relative z-10 border-t border-border/60 bg-surface/70 backdrop-blur supports-[backdrop-filter]:bg-surface/60">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-2 sm:px-8 sm:py-3">
          <div className="flex min-h-[2.25rem] items-center gap-2 text-xs text-muted">
            {footerLeft}
          </div>

          <div className="flex items-center gap-2">
            <ProgressDots
              total={totalSteps}
              current={stepIndex}
              className="mr-2 sm:hidden"
            />

            {onBack && (
              <Button
                variant="ghost"
                size="md"
                leftIcon={<ArrowLeft className="h-4 w-4" />}
                onClick={onBack}
              >
                Back
              </Button>
            )}
            {onSkip && (
              <Button variant="subtle" size="md" onClick={onSkip}>
                {skipLabel}
              </Button>
            )}
            {onNext && (
              <Button
                variant="primary"
                size="md"
                disabled={nextDisabled}
                rightIcon={<ArrowRight className="h-4 w-4" />}
                onClick={onNext}
              >
                {nextLabel}
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
