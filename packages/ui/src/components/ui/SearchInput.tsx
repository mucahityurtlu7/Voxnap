import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Search, X } from "lucide-react";

export interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Render a clear button when value is non-empty. */
  onClear?: () => void;
  trailing?: ReactNode;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    { className, onClear, value, trailing, placeholder = "Search…", ...rest },
    ref,
  ) {
    const showClear = onClear && typeof value === "string" && value.length > 0;
    return (
      <div
        className={clsx(
          "group inline-flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5",
          "transition-colors focus-within:border-brand-500/60 focus-within:ring-2 focus-within:ring-brand-500/20",
          className,
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <input
          ref={ref}
          value={value}
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
          {...rest}
        />
        {showClear && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear search"
            className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-surface-3 hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {trailing}
      </div>
    );
  },
);
