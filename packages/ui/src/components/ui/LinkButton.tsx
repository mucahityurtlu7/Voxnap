/**
 * LinkButton — react-router `<Link>` styled like a `<Button>`.
 *
 * Existed to fix invalid HTML in places that previously rendered
 * `<Button><Link>...</Link></Button>` (an `<a>` inside a `<button>`).
 * Use this when the action *navigates* somewhere; use `<Button>` for
 * everything else.
 */
import type { ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

import { buttonClasses, type ButtonSize, type ButtonVariant } from "./Button.js";

export interface LinkButtonProps extends Omit<LinkProps, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  leftIcon,
  rightIcon,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link className={buttonClasses({ variant, size, className })} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </Link>
  );
}
