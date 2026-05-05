/**
 * Theme hook — toggles `dark` class on <html> based on user preference.
 *
 * Three modes:
 *   "light"   — force light
 *   "dark"    — force dark
 *   "system"  — follow `prefers-color-scheme`
 *
 * Persists to localStorage; all three apps see the same preference.
 */
import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

const KEY = "voxnap.theme";

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function apply(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const dark = mode === "dark" || (mode === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export interface UseThemeApi {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

export function useTheme(): UseThemeApi {
  const [mode, setModeState] = useState<ThemeMode>(() => readMode());
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    mode === "dark" || (mode === "system" && systemPrefersDark()) ? "dark" : "light",
  );

  // Apply on mount and whenever mode changes.
  useEffect(() => {
    apply(mode);
    setResolved(
      mode === "dark" || (mode === "system" && systemPrefersDark()) ? "dark" : "light",
    );
  }, [mode]);

  // Listen to system changes when in system mode.
  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      apply("system");
      setResolved(mq.matches ? "dark" : "light");
    };
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    if (typeof window !== "undefined") {
      if (m === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, m);
    }
    setModeState(m);
  }, []);

  const toggle = useCallback(() => {
    setMode(resolved === "dark" ? "light" : "dark");
  }, [resolved, setMode]);

  return { mode, resolved, setMode, toggle };
}

/**
 * Call once near the root to apply the saved theme before paint, avoiding
 * a flash of the wrong colours.
 */
export function ensureThemeApplied(): void {
  apply(readMode());
}
