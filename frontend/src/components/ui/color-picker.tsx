import type { CSSProperties } from "react";
import "../../styles/form-controls.css";

export function ColorPicker({
  value,
  onChange,
  label,
  selected = false,
}: {
  value: string;
  onChange: (color: string) => void;
  label: string;
  selected?: boolean;
}) {
  return (
    <label
      className="ui-color-picker"
      data-selected={selected || undefined}
      title={label}
      style={{ "--selected-color": value } as CSSProperties}
    >
      <span className="ui-color-picker-swatch" aria-hidden="true" />
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
