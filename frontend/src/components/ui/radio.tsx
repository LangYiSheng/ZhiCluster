import { forwardRef, type InputHTMLAttributes } from "react";
import { clsx } from "clsx";
import "../../styles/form-controls.css";

export const Radio = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => (
  <input
    {...props}
    ref={ref}
    type="radio"
    className={clsx("ui-radio", className)}
  />
));
Radio.displayName = "Radio";
