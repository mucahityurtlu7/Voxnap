/**
 * Shortcut — platform-aware `<Kbd>` group.
 *
 *   <Shortcut keys="mod+k" />          // ⌘K on macOS, CtrlK elsewhere
 *   <Shortcut keys="mod+shift+." />    // ⌘ ⇧ . / Ctrl ⇧ .
 *
 * Centralises the look so Topbar, Hero, CommandPalette and Settings
 * all render shortcuts in the exact same dialect.
 */
import clsx from "clsx";

import { Kbd } from "./Kbd.js";
import { formatShortcut } from "../../hooks/useShortcuts.js";

export interface ShortcutProps {
  keys: string;
  className?: string;
  /** Default is a small inline group; "compact" tightens spacing. */
  variant?: "default" | "compact";
}

export function Shortcut({ keys, className, variant = "default" }: ShortcutProps) {
  const parts = formatShortcut(keys).split(" ").filter(Boolean);
  return (
    <span
      className={clsx(
        "inline-flex items-center",
        variant === "compact" ? "gap-0.5" : "gap-1",
        className,
      )}
      aria-label={`Keyboard shortcut: ${parts.join(" then ")}`}
    >
      {parts.map((p, i) => (
        <Kbd key={i}>{p}</Kbd>
      ))}
    </span>
  );
}
