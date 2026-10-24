export type FocusOrigin = {
  target: HTMLElement | null;
  fallback: HTMLElement | null;
};

// Keep the source attached to the particular menu, including while its content
// unmounts into a Dialog. A global "last clicked" source would mix unrelated opens.
const menuOrigins = new WeakMap<HTMLElement, FocusOrigin>();
const focusable =
  'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]';

export function usableFocusTarget(
  element: HTMLElement | null,
): element is HTMLElement {
  if (
    !element?.isConnected ||
    element === document.body ||
    element === document.documentElement ||
    element.matches(":disabled") ||
    element.closest('[hidden], [inert], [aria-hidden="true"]')
  )
    return false;
  for (
    let ancestor: HTMLElement | null = element;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return element.matches(focusable);
}

export function menuFocusOrigin(trigger: HTMLElement | null): FocusOrigin {
  const active = document.activeElement;
  let target =
    active instanceof HTMLElement && trigger?.contains(active)
      ? active
      : trigger;
  if (!usableFocusTarget(target)) {
    target = trigger
      ? Array.from(trigger.querySelectorAll<HTMLElement>(focusable)).find(
          usableFocusTarget,
        ) || null
      : null;
  }
  return {
    target,
    fallback:
      trigger?.closest<HTMLElement>("[data-focus-return-scope]") || null,
  };
}

export function registerMenuOrigin(content: HTMLElement, origin: FocusOrigin) {
  menuOrigins.set(content, origin);
}

export function resolveFocusOrigin(
  previous: EventTarget | null,
): FocusOrigin | null {
  if (!(previous instanceof HTMLElement)) return null;
  const menu = previous.closest<HTMLElement>('[role="menu"]');
  return (
    (menu && menuOrigins.get(menu)) || {
      target: previous,
      fallback: previous.closest<HTMLElement>("[data-focus-return-scope]"),
    }
  );
}

export function restoreFocusOrigin(
  origin: FocusOrigin | null,
  closingContent: HTMLElement | null,
) {
  const active = document.activeElement;
  // Navigation or another Dialog may already own focus. Do not override it with
  // a deferred close callback from the old context.
  if (
    active instanceof HTMLElement &&
    usableFocusTarget(active) &&
    !closingContent?.contains(active)
  )
    return;
  for (const target of [origin?.target, origin?.fallback]) {
    if (!target || !usableFocusTarget(target)) continue;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
}
