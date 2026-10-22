import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { clsx } from "clsx";
const variants = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
    size: { default: "", icon: "button-icon", sm: "button-sm" },
  },
  defaultVariants: { variant: "secondary", size: "default" },
});
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "default" | "secondary" | "ghost" | "danger";
    size?: "default" | "icon" | "sm";
  }
>(({ className, variant, size, ...props }, ref) => (
  <button
    ref={ref}
    className={clsx(variants({ variant, size }), className)}
    {...props}
  />
));
Button.displayName = "Button";
