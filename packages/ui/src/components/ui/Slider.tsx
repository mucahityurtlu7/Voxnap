import clsx from "clsx";
import type { InputHTMLAttributes } from "react";

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  unit?: string;
  formatValue?: (n: number) => string;
}

export function Slider({
  label,
  unit,
  value,
  formatValue,
  className,
  ...rest
}: SliderProps) {
  const display =
    typeof value === "number" || typeof value === "string"
      ? formatValue
        ? formatValue(Number(value))
        : `${value}${unit ?? ""}`
      : "";
  return (
    <label className={clsx("flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between text-xs">
        {label && <span className="font-medium text-text">{label}</span>}
        {display && <span className="font-mono text-muted">{display}</span>}
      </div>
      <input
        type="range"
        value={value}
        className={clsx(
          "h-1.5 w-full appearance-none rounded-full bg-surface-3",
          "accent-brand-500",
          "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4",
          "[&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:bg-brand-500 [&::-webkit-slider-thumb]:shadow-soft",
        )}
        {...rest}
      />
    </label>
  );
}
