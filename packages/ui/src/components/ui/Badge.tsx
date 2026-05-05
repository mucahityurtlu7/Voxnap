import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";
import type { SpeakerColor } from "@voxnap/core";

export type BadgeTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | SpeakerColor;

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-text-subtle border-border",
  brand: "bg-brand-500/10 text-brand-700 border-brand-500/30 dark:text-brand-300",
  success: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
  warning: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300",
  danger: "bg-rose-500/10 text-rose-700 border-rose-500/30 dark:text-rose-300",
  violet: "bg-violet-500/10 text-violet-700 border-violet-500/30 dark:text-violet-300",
  sky: "bg-sky-500/10 text-sky-700 border-sky-500/30 dark:text-sky-300",
  emerald: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
  amber: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300",
  rose: "bg-rose-500/10 text-rose-700 border-rose-500/30 dark:text-rose-300",
  cyan: "bg-cyan-500/10 text-cyan-700 border-cyan-500/30 dark:text-cyan-300",
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-700 border-fuchsia-500/30 dark:text-fuchsia-300",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Render a small status dot before the label. */
  dot?: boolean;
  icon?: ReactNode;
  size?: "sm" | "md";
}

export function Badge({
  tone = "neutral",
  dot,
  icon,
  size = "sm",
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border font-medium",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {icon}
      {children}
    </span>
  );
}
