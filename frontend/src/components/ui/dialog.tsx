import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, useCallback, useRef } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { resolveFocusOrigin, restoreFocusOrigin } from "./focusReturn";
import type { FocusOrigin } from "./focusReturn";

// Portal mounts a fresh Content for each open cycle. Keep the source here until
// Radix's deferred close autofocus has run, rather than clearing it on open=false.
const FocusReturnContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function FocusReturnContent(
  { onFocusCapture, onCloseAutoFocus, ...props },
  forwardedRef,
) {
  const origin = useRef<FocusOrigin | null>(null);
  const entered = useRef(false);
  const content = useRef<HTMLDivElement | null>(null);
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) content.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  return (
    <DialogPrimitive.Content
      {...props}
      data-focus-return-scope
      ref={contentRef}
      onFocusCapture={(event) => {
        if (!entered.current) {
          entered.current = true;
          origin.current = resolveFocusOrigin(event.relatedTarget);
        }
        onFocusCapture?.(event);
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        restoreFocusOrigin(origin.current, content.current);
      }}
    />
  );
});

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  className = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <FocusReturnContent
          className={`dialog-content ${wide ? "dialog-wide" : ""} ${className}`}
          aria-describedby={description ? "dialog-description" : undefined}
        >
          <DialogPrimitive.Title className="dialog-title">
            {title}
          </DialogPrimitive.Title>
          {description && (
            <DialogPrimitive.Description
              id="dialog-description"
              className="muted"
            >
              {description}
            </DialogPrimitive.Description>
          )}
          <DialogPrimitive.Close
            className="button button-ghost button-icon dialog-close"
            aria-label="关闭"
          >
            <X size={18} />
          </DialogPrimitive.Close>
          {children}
        </FocusReturnContent>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
