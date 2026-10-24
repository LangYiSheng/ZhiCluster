import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
const MenuKind = createContext<"dropdown" | "context">("dropdown");

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
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <ContextMenuPrimitive.Root
      modal={false}
      open={active && open}
      onOpenChange={setOpen}
    >
      <ContextMenuPrimitive.Trigger asChild disabled={!active}>
        {trigger}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
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
  return (
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
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
