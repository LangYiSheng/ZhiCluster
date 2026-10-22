import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEvents } from "./events";
class FakeSource {
  static sources: FakeSource[] = [];
  listeners: Record<string, (event: MessageEvent) => void> = {};
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.sources.push(this);
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners[name] = listener;
  }
  close() {
    this.closed = true;
  }
  send(type: string, sequence: number, data: unknown) {
    this.listeners[type]?.({
      type,
      lastEventId: String(sequence),
      data: JSON.stringify(data),
    } as MessageEvent);
  }
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  FakeSource.sources = [];
});
it("SSE保存游标、丢弃重复事件并在视图切换时关闭订阅", () => {
  vi.stubGlobal("EventSource", FakeSource);
  const receive = vi.fn();
  const hook = renderHook(() => useEvents("/runs/1/events", receive));
  const first = FakeSource.sources[0];
  act(() => {
    first.send("token", 4, { token: "真实事件格式" });
    first.send("token", 4, { token: "重复事件" });
  });
  expect(receive).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem("events:/runs/1/events")).toBe("4");
  hook.unmount();
  expect(first.closed).toBe(true);
  renderHook(() => useEvents("/runs/1/events", receive));
  expect(FakeSource.sources[1].url).toContain("after=4");
});
