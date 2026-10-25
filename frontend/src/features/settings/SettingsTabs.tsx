import { useId } from "react";

export function SettingsTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  panelId,
  idPrefix,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  panelId?: (value: T) => string;
  idPrefix?: string;
}) {
  const generatedId = useId();
  const id = idPrefix || generatedId;
  return (
    <div className="zc-settings-tabs" role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button
          type="button"
          role="tab"
          key={option.value}
          id={`${id}-${option.value}`}
          aria-controls={panelId?.(option.value)}
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            let next: number;
            if (event.key === "ArrowRight") next = (index + 1) % options.length;
            else if (event.key === "ArrowLeft")
              next = (index - 1 + options.length) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else return;
            event.preventDefault();
            onChange(options[next].value);
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              );
            buttons?.[next]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
