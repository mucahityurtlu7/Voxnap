import type { ReactNode } from "react";
import clsx from "clsx";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border-strong bg-surface-2 p-10 text-center",
        className,
      )}
    >
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-gradient-soft text-brand-600 dark:text-brand-300">
          {icon}
        </div>
      )}
      <div className="max-w-sm">
        <div className="text-sm font-semibold text-text">{title}</div>
        {description && (
          <div className="mt-1 text-xs text-muted">{description}</div>
        )}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
