import { useState, type ReactNode } from "react";
import clsx from "clsx";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

/**
 * Bare-bones CSS tooltip. Good enough for shortcut hints and label
 * fallbacks; we intentionally avoid pulling in a positioning lib.
 */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={clsx("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <span
        role="tooltip"
        className={clsx(
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text shadow-soft",
          "transition-opacity duration-150",
          open ? "opacity-100" : "opacity-0",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {content}
      </span>
    </span>
  );
}
