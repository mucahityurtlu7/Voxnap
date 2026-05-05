import clsx from "clsx";
import type { SpeakerColor } from "@voxnap/core";

export interface AvatarProps {
  label: string;
  color?: SpeakerColor;
  size?: "xs" | "sm" | "md";
  className?: string;
}

const COLORS: Record<SpeakerColor, string> = {
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  rose: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  cyan: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
};

const SIZES = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-6 w-6 text-[11px]",
  md: "h-8 w-8 text-xs",
};

function initials(label: string): string {
  const parts = label.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function Avatar({ label, color = "violet", size = "sm", className }: AvatarProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center rounded-full font-semibold ring-1 ring-inset ring-current/10",
        COLORS[color],
        SIZES[size],
        className,
      )}
      title={label}
    >
      {initials(label)}
    </span>
  );
}
