/**
 * Toast — minimal global notification system.
 *
 * `useToasts()` returns a `push(toast)` callback any component can use.
 * `<ToastViewport />` is mounted once near the root and renders the queue.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface Toast {
  id: string;
  tone?: ToastTone;
  title: string;
  description?: string;
  /** ms; defaults to 3500. Pass 0 to keep until dismissed. */
  duration?: number;
}

interface ToastCtx {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((q) => q.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastCtx["push"]>(
    (t) => {
      const id = `toast_${++counter}`;
      const duration = t.duration ?? 3500;
      setToasts((q) => [...q, { ...t, id }]);
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useToasts(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useToasts() called outside <ToastProvider>");
  }
  return ctx;
}

const TONE_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertTriangle,
};

const TONE_BORDER = {
  info: "border-l-brand-500",
  success: "border-l-emerald-500",
  warning: "border-l-amber-500",
  danger: "border-l-rose-500",
};

export function ToastViewport() {
  const ctx = useContext(Ctx);
  // Always-mounted is fine; if no provider, render nothing.
  if (!ctx) return null;
  const { toasts, dismiss } = ctx;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const Icon = TONE_ICON[t.tone ?? "info"];
        return (
          <div
            key={t.id}
            role="status"
            className={clsx(
              "pointer-events-auto flex items-start gap-3 rounded-xl border border-l-4 border-border bg-surface p-3 pr-2 shadow-soft animate-fade-in",
              TONE_BORDER[t.tone ?? "info"],
            )}
          >
            <Icon className="mt-0.5 h-4 w-4 text-brand-500" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-text">{t.title}</div>
              {t.description && (
                <div className="mt-0.5 text-xs text-muted">{t.description}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Auto-dismiss helper exposed for tests; pure side-effect. */
export function useToastTimer() {
  const ctx = useContext(Ctx);
  useEffect(() => {
    /* no-op; provider already manages durations */
  }, [ctx]);
}
