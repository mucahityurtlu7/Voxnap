import clsx from "clsx";
import type { ReactNode } from "react";

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return <kbd className={clsx("vx-kbd", className)}>{children}</kbd>;
}

export function KbdGroup({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1", className)}>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}
