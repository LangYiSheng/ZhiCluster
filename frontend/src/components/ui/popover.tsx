import * as PopoverPrimitive from "@radix-ui/react-popover";
import { X } from "lucide-react";
import { useId, useRef } from "react";
import type { ReactNode } from "react";

/** A compact, non-modal card attached to its trigger or an existing button. */
export function Popover({
  open,
  onOpenChange,
  title,
  trigger,
  anchorElement,
  side = "bottom",
  align = "end",
  className = "",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  trigger?: ReactNode;
  anchorElement?: HTMLElement | null;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const interactedOutside = useRef(false);
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
    >
      {trigger && (
        <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      )}
      {anchorElement && (
        <PopoverPrimitive.Anchor virtualRef={{ current: anchorElement }} />
      )}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className={`popover-content ${className}`}
          side={side}
          align={align}
          sideOffset={10}
          collisionPadding={12}
          sticky="always"
          aria-labelledby={titleId}
          onOpenAutoFocus={() => {
            interactedOutside.current = false;
          }}
          onInteractOutside={(event) => {
            const target = event.target;
            // The external anchor owns its toggle; do not dismiss and reopen it.
            if (target instanceof Node && anchorElement?.contains(target)) {
              event.preventDefault();
              return;
            }
            interactedOutside.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (anchorElement) {
              event.preventDefault();
              if (!interactedOutside.current) anchorElement.focus();
            }
          }}
        >
          <div className="popover-heading">
            <h2 id={titleId}>{title}</h2>
            <PopoverPrimitive.Close
              className="button button-ghost button-icon"
              aria-label="关闭"
            >
              <X size={16} />
            </PopoverPrimitive.Close>
          </div>
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
