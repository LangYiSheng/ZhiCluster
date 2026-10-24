import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { menuFocusOrigin, registerMenuOrigin } from "./focusReturn";
import type { FocusOrigin } from "./focusReturn";
const MenuKind = createContext<"dropdown" | "context">("dropdown");

function useMenuFocusReturn() {
  const trigger = useRef<HTMLElement | null>(null);
  const origin = useRef<FocusOrigin>({ target: null, fallback: null });
  return {
    triggerRef: (node: HTMLElement | null) => {
      trigger.current = node;
    },
    contentRef: (node: HTMLElement | null) => {
      if (node) registerMenuOrigin(node, origin.current);
    },
    remember: () => {
      origin.current = menuFocusOrigin(trigger.current);
    },
  };
}

export function ContextMenu({
  trigger,
  children,
  active = true,
}: {
  trigger: ReactNode;
  children: ReactNode;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const focusReturn = useMenuFocusReturn();
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <ContextMenuPrimitive.Root
      modal={false}
      open={active && open}
      onOpenChange={(next) => {
        if (next) focusReturn.remember();
        setOpen(next);
      }}
    >
      <ContextMenuPrimitive.Trigger
        ref={focusReturn.triggerRef}
        asChild
        disabled={!active}
      >
        {trigger}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          ref={focusReturn.contentRef}
          className="menu-content"
          collisionPadding={12}
          loop
        >
          <MenuKind.Provider value="context">{children}</MenuKind.Provider>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
export function Menu({
  trigger,
  children,
}: {
  trigger: ReactNode;
  children: ReactNode;
}) {
  const focusReturn = useMenuFocusReturn();
  return (
    <MenuPrimitive.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) focusReturn.remember();
      }}
    >
      <MenuPrimitive.Trigger ref={focusReturn.triggerRef} asChild>
        {trigger}
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          ref={focusReturn.contentRef}
          className="menu-content"
          sideOffset={5}
          align="end"
        >
          <MenuKind.Provider value="dropdown">{children}</MenuKind.Provider>
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
export function MenuItem({
  children,
  onSelect,
  danger = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}) {
  const Item =
    useContext(MenuKind) === "context"
      ? ContextMenuPrimitive.Item
      : MenuPrimitive.Item;
  return (
    <Item className={`menu-item ${danger ? "danger" : ""}`} onSelect={onSelect}>
      {children}
    </Item>
  );
}
