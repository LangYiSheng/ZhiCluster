import "@testing-library/jest-dom/vitest";

// The browser supplies these pointer/scroll APIs used by Radix Select. jsdom
// has no layout or pointer capture, so provide only the missing browser surface.
if (!window.PointerEvent) {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: TestPointerEvent,
  });
}
for (const method of [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
  "scrollIntoView",
] as const) {
  if (!Element.prototype[method]) {
    Object.defineProperty(Element.prototype, method, {
      configurable: true,
      writable: true,
      value: method === "hasPointerCapture" ? () => false : () => {},
    });
  }
}
