import clsx from "clsx";

export interface ProgressDotsProps {
  total: number;
  current: number;
  /** Optional click target so users can jump back to a previous step. */
  onJump?: (index: number) => void;
  className?: string;
}

/**
 * A minimal step-indicator: filled brand pill for the current step, soft
 * dots for the rest. Each dot is keyboard-focusable when `onJump` is set.
 */
export function ProgressDots({
  total,
  current,
  onJump,
  className,
}: ProgressDotsProps) {
  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current + 1}
      className={clsx("flex items-center gap-1.5", className)}
    >
      {Array.from({ length: total }, (_, i) => {
        const isCurrent = i === current;
        const isDone = i < current;
        const dot = (
          <span
            className={clsx(
              "block h-1.5 rounded-full transition-all duration-300",
              isCurrent
                ? "w-7 bg-brand-500"
                : isDone
                  ? "w-1.5 bg-brand-500/60"
                  : "w-1.5 bg-border-strong",
            )}
          />
        );
        if (!onJump || i > current) {
          // Future steps are non-interactive; only completed ones are jumpable.
          return (
            <span
              key={i}
              aria-current={isCurrent ? "step" : undefined}
              className="flex h-4 items-center"
            >
              {dot}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            aria-label={`Go to step ${i + 1}`}
            onClick={() => onJump(i)}
            className="flex h-4 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            {dot}
          </button>
        );
      })}
    </div>
  );
}
