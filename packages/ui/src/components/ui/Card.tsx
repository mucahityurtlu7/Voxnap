import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** When true, omit the surface fill (used for completely custom cards). */
  bare?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { bare, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        "rounded-2xl border border-border",
        !bare && "bg-surface",
        "shadow-soft",
        className,
      )}
      {...rest}
    />
  );
});

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  className,
  children,
  ...rest
}: CardHeaderProps) {
  return (
    <div
      className={clsx(
        "flex items-start justify-between gap-3 border-b border-border px-5 py-4",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="vx-eyebrow mb-1">{eyebrow}</div>}
        {title && (
          <div className="truncate text-sm font-semibold text-text">{title}</div>
        )}
        {subtitle && (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted">{subtitle}</div>
        )}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("p-5", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-2 border-t border-border px-5 py-3",
        className,
      )}
      {...rest}
    />
  );
}
