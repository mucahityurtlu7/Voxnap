import { useEffect, type ReactNode } from "react";
import clsx from "clsx";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  /** Hide the default backdrop click-to-close behaviour. */
  preventCloseOnBackdrop?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  children,
  className,
  preventCloseOnBackdrop,
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8">
      <div
        aria-hidden
        onClick={() => !preventCloseOnBackdrop && onOpenChange(false)}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
      />
      <div
        role="dialog"
        aria-modal
        className={clsx(
          "relative z-10 mt-[10vh] w-full max-w-2xl rounded-2xl border border-border bg-surface shadow-soft animate-fade-in",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
