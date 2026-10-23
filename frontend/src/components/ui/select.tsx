import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { clsx } from "clsx";
import "../../styles/form-controls.css";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps = Omit<
  ComponentPropsWithoutRef<typeof Primitive.Trigger>,
  "children" | "value" | "defaultValue" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  name?: string;
  required?: boolean;
  size?: "default" | "sm";
};

// Radix reserves the empty string for a placeholder. Prefix every option so a
// real "all items / no folder" option can keep its ordinary empty API value.
const encodeValue = (value: string) => `option:${value}`;

export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      value,
      onValueChange,
      options,
      placeholder = "请选择",
      name,
      required,
      disabled,
      className,
      onPointerDown,
      onKeyDown,
      onClick,
      size = "default",
      ...props
    },
    ref,
  ) => (
    <>
      {name && (
        <input type="hidden" name={name} value={value} disabled={disabled} />
      )}
      <Primitive.Root
        value={
          (!required || value !== "") &&
          options.some((option) => option.value === value)
            ? encodeValue(value)
            : ""
        }
        onValueChange={(nextValue) => onValueChange(nextValue.slice(7))}
        disabled={disabled}
        required={required}
      >
        <Primitive.Trigger
          {...props}
          ref={ref}
          className={clsx("ui-select-trigger", `ui-select-${size}`, className)}
          onPointerDown={(event) => {
            if (event.currentTarget.matches(":disabled"))
              event.preventDefault();
            else onPointerDown?.(event);
          }}
          onKeyDown={(event) => {
            if (event.currentTarget.matches(":disabled"))
              event.preventDefault();
            else onKeyDown?.(event);
          }}
          onClick={(event) => {
            if (event.currentTarget.matches(":disabled"))
              event.preventDefault();
            else onClick?.(event);
          }}
        >
          <Primitive.Value
            placeholder={
              required && value === ""
                ? options.find((option) => option.value === "")?.label ||
                  placeholder
                : placeholder
            }
          />
          <Primitive.Icon asChild>
            <ChevronDown size={15} aria-hidden="true" />
          </Primitive.Icon>
        </Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            className="ui-select-content"
            position="popper"
            sideOffset={5}
            collisionPadding={12}
          >
            <Primitive.ScrollUpButton className="ui-select-scroll">
              <ChevronUp size={14} />
            </Primitive.ScrollUpButton>
            <Primitive.Viewport className="ui-select-viewport">
              {options.map((option) => (
                <Primitive.Item
                  key={option.value}
                  value={encodeValue(option.value)}
                  disabled={option.disabled}
                  className="ui-select-option"
                  textValue={option.label}
                >
                  <Primitive.ItemText>{option.label}</Primitive.ItemText>
                  <Primitive.ItemIndicator className="ui-select-check">
                    <Check size={14} />
                  </Primitive.ItemIndicator>
                </Primitive.Item>
              ))}
            </Primitive.Viewport>
            <Primitive.ScrollDownButton className="ui-select-scroll">
              <ChevronDown size={14} />
            </Primitive.ScrollDownButton>
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </>
  ),
);
Select.displayName = "Select";
