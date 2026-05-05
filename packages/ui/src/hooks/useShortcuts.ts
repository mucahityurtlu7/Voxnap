/**
 * Keyboard shortcut hook.
 *
 * Pass an array of bindings; we set up a single window listener and
 * dispatch to the right handler. We special-case ⌘ on macOS and Ctrl
 * everywhere else.
 *
 * Bindings are registered as e.g.:
 *   { keys: "mod+k", run: () => openPalette() }
 *   { keys: "shift+/", run: () => showHelp() }
 *
 * `mod` resolves to `meta` on macOS, `ctrl` elsewhere.
 */
import { useEffect, useMemo } from "react";

export interface ShortcutBinding {
  keys: string;
  description?: string;
  /** Don't fire while focus is in an editable element (input/textarea). */
  preventInsideInput?: boolean;
  run: (e: KeyboardEvent) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

function normaliseKey(k: string): string {
  return k
    .trim()
    .toLowerCase()
    .replace("mod", isMac ? "meta" : "ctrl")
    .replace("cmd", "meta")
    .replace("control", "ctrl")
    .replace("option", "alt")
    .replace(" ", "+");
}

function eventKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const k = e.key.toLowerCase();
  // Spelt-out keys
  if (k === " ") parts.push("space");
  else if (k === "escape") parts.push("esc");
  else parts.push(k);
  return parts.join("+");
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useShortcuts(bindings: ShortcutBinding[]): void {
  // Pre-normalise outside the effect so the lookup is fast.
  const map = useMemo(() => {
    const m = new Map<string, ShortcutBinding>();
    for (const b of bindings) {
      m.set(normaliseKey(b.keys), b);
    }
    return m;
  }, [bindings]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = eventKey(e);
      const b = map.get(key);
      if (!b) return;
      if (b.preventInsideInput && isEditable(e.target)) return;
      e.preventDefault();
      b.run(e);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [map]);
}

/** Render-friendly representation of a shortcut for tooltips/menus. */
export function formatShortcut(keys: string): string {
  const parts = normaliseKey(keys).split("+");
  return parts
    .map((p) =>
      p === "meta" ? (isMac ? "⌘" : "Win")
      : p === "ctrl" ? "Ctrl"
      : p === "alt" ? (isMac ? "⌥" : "Alt")
      : p === "shift" ? "⇧"
      : p === "esc" ? "Esc"
      : p === "space" ? "Space"
      : p.length === 1 ? p.toUpperCase()
      : p[0]!.toUpperCase() + p.slice(1),
    )
    .join(" ");
}
