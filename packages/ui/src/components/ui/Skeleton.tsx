import clsx from "clsx";
import type { HTMLAttributes } from "react";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  rounded?: "sm" | "md" | "lg" | "full";
}

export function Skeleton({ className, rounded = "md", ...rest }: SkeletonProps) {
  const r = {
    sm: "rounded-sm",
    md: "rounded-md",
    lg: "rounded-lg",
    full: "rounded-full",
  }[rounded];
  return <div className={clsx("vx-shimmer h-4 w-full", r, className)} {...rest} />;
}
