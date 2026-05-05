import { Mic, MicOff, Loader2 } from "lucide-react";
import clsx from "clsx";
import type { EngineState } from "@voxnap/core";

export interface MicButtonProps {
  state: EngineState;
  onStart: () => void;
  onStop: () => void;
  /** 0..1 audio level driving the pulsing ring. */
  level?: number;
  size?: "md" | "lg";
  className?: string;
}

/**
 * Big circular record button with two reactive halos.
 *
 *   • Outer halo pulses at audio level (running state)
 *   • Inner ring scales subtly for tactile feedback on hover
 */
export function MicButton({
  state,
  onStart,
  onStop,
  level = 0,
  size = "lg",
  className,
}: MicButtonProps) {
  const isRunning = state === "running";
  const isLoading = state === "loading-model";
  const disabled = isLoading || state === "disposed";

  const onClick = () => {
    if (isRunning) onStop();
    else onStart();
  };

  // The halo scales with audio level; clamped + smoothed.
  const haloScale = isRunning ? 1 + Math.min(level, 1) * 0.55 : 1;
  const haloOpacity = isRunning ? 0.35 + Math.min(level, 1) * 0.25 : 0.18;

  const dim = size === "lg" ? "h-24 w-24" : "h-16 w-16";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={isRunning ? "Stop recording" : "Start recording"}
      className={clsx(
        "relative inline-flex items-center justify-center rounded-full",
        "outline-none transition-transform duration-150 ease-spring",
        "focus-visible:ring-4 focus-visible:ring-brand-500/30",
        disabled && "opacity-60 cursor-not-allowed",
        "hover:scale-[1.02] active:scale-[0.98]",
        dim,
        className,
      )}
    >
      {/* Outer halo — react to audio level */}
      <span
        aria-hidden
        className={clsx(
          "absolute inset-0 rounded-full transition-[transform,opacity] duration-100 ease-out blur-md",
          isRunning ? "bg-rose-500" : "bg-brand-500",
        )}
        style={{ transform: `scale(${haloScale})`, opacity: haloOpacity }}
      />

      {/* Inner shell with gradient */}
      <span
        className={clsx(
          "relative flex h-full w-full items-center justify-center rounded-full text-white shadow-glow",
          isRunning
            ? "bg-gradient-to-br from-rose-500 to-rose-600"
            : "bg-gradient-to-br from-brand-500 via-brand-600 to-brand-700",
        )}
      >
        {/* Inner ring */}
        <span className="absolute inset-1 rounded-full border border-white/20" />
        {isLoading ? (
          <Loader2 className={clsx(size === "lg" ? "h-9 w-9" : "h-6 w-6", "animate-spin")} />
        ) : isRunning ? (
          <MicOff className={size === "lg" ? "h-9 w-9" : "h-6 w-6"} />
        ) : (
          <Mic className={size === "lg" ? "h-9 w-9" : "h-6 w-6"} />
        )}
      </span>

      {/* Hard pulse ring on running */}
      {isRunning && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full border-2 border-rose-500/50 animate-pulse-ring"
        />
      )}
    </button>
  );
}
