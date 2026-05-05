import { forwardRef, type SelectHTMLAttributes } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "sm" | "md";
}

/**
 * Native <select> wrapped to match Voxnap's styling.
 *
 * We deliberately use the native element so the OS picker stays accessible
 * on mobile — no custom popover juggling.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = "md", children, ...rest },
  ref,
) {
  return (
    <div
      className={clsx(
        "relative inline-flex w-full items-center rounded-lg border border-border bg-surface-2",
        "transition-colors focus-within:border-brand-500/60 focus-within:ring-2 focus-within:ring-brand-500/20",
        size === "sm" ? "h-8 text-xs" : "h-9 text-sm",
        className,
      )}
    >
      <select
        ref={ref}
        className={clsx(
          "h-full w-full appearance-none bg-transparent pl-3 pr-8 text-text outline-none",
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-muted" />
    </div>
  );
});
