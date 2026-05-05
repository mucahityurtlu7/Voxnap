import {
  createContext,
  useContext,
  useId,
  type ReactNode,
} from "react";
import clsx from "clsx";

interface TabsCtx {
  value: string;
  onChange: (v: string) => void;
  base: string;
}

const Ctx = createContext<TabsCtx | null>(null);

export interface TabsProps {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}

export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const base = useId();
  return (
    <Ctx.Provider value={{ value, onChange: onValueChange, base }}>
      <div className={clsx("flex flex-col gap-3", className)}>{children}</div>
    </Ctx.Provider>
  );
}

export function TabsList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={clsx(
        "inline-flex w-fit gap-1 rounded-lg border border-border bg-surface-2 p-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface TabProps {
  value: string;
  children: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export function Tab({ value, children, badge, disabled }: TabProps) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("<Tab> must be used inside <Tabs>");
  const active = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={`${ctx.base}-${value}`}
      disabled={disabled}
      onClick={() => ctx.onChange(value)}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium",
        "transition-colors duration-150",
        active
          ? "bg-surface text-text shadow-soft"
          : "text-muted hover:text-text",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
      {badge}
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("<TabPanel> must be used inside <Tabs>");
  if (ctx.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.base}-${value}`}
      className={clsx("animate-fade-in", className)}
    >
      {children}
    </div>
  );
}
