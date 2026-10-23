import { forwardRef, type InputHTMLAttributes } from "react";
import { clsx } from "clsx";
import "../../styles/form-controls.css";

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  indeterminate?: boolean;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, ...props }, ref) => (
    <input
      {...props}
      type="checkbox"
      className={clsx("ui-checkbox", className)}
      aria-checked={indeterminate ? "mixed" : props["aria-checked"]}
      ref={(element) => {
        if (element) element.indeterminate = indeterminate;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
    />
  ),
);
Checkbox.displayName = "Checkbox";
