import clsx from "clsx";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: ToggleProps) {
  return (
    <label
      className={clsx(
        "flex select-none items-start justify-between gap-4",
        disabled && "opacity-60",
        className,
      )}
    >
      {(label || description) && (
        <div className="min-w-0">
          {label && (
            <div className="text-sm font-medium text-text">{label}</div>
          )}
          {description && (
            <div className="mt-0.5 text-xs text-muted">{description}</div>
          )}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
          checked
            ? "border-brand-500 bg-brand-500"
            : "border-border-strong bg-surface-3",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-soft transition-transform duration-200",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    </label>
  );
}
