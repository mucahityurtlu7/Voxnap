import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "subtle";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 shadow-soft",
  secondary:
    "bg-surface text-text border border-border hover:bg-surface-3",
  ghost: "bg-transparent text-text hover:bg-surface-3",
  danger:
    "bg-danger-500 text-white hover:bg-rose-500 active:bg-rose-600 shadow-soft",
  subtle:
    "bg-surface-2 text-text border border-transparent hover:border-border hover:bg-surface-3",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-9 px-3.5 text-sm gap-2 rounded-md",
  lg: "h-11 px-5 text-sm gap-2 rounded-lg",
};

/**
 * Voxnap's primary button. Tiny on purpose — no headless library.
 * Variants are semantic, sizing is consistent across the whole app.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading,
    disabled,
    leftIcon,
    rightIcon,
    className,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex select-none items-center justify-center font-medium",
        "transition-colors duration-150 outline-none",
        "focus-visible:ring-2 focus-visible:ring-brand-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className={clsx(size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4", "animate-spin")} />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { variant = "ghost", size = "md", className, label, children, type = "button", ...rest },
    ref,
  ) {
    const sizeMap: Record<ButtonSize, string> = {
      sm: "h-7 w-7 rounded-md",
      md: "h-9 w-9 rounded-md",
      lg: "h-11 w-11 rounded-lg",
    };
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={clsx(
          "inline-flex items-center justify-center transition-colors duration-150 outline-none",
          "focus-visible:ring-2 focus-visible:ring-brand-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "disabled:cursor-not-allowed disabled:opacity-50",
          VARIANTS[variant],
          sizeMap[size],
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
