import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Message } from "../../lib/api";
import { useChatStream } from "./useChatStream";

class StreamSource {
  static all: StreamSource[] = [];
  listeners: Record<string, (event: MessageEvent) => void> = {};
  close = vi.fn();
  constructor() {
    StreamSource.all.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners[type] = listener;
  }
  send(type: string, sequence: number, data: Record<string, unknown>) {
    this.listeners[type]?.({
      type,
      lastEventId: String(sequence),
      data: JSON.stringify(data),
    } as MessageEvent);
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StreamSource.all = [];
  sessionStorage.clear();
});

it("高频token合批投影，完成立即落定，同一消息无重复气泡，切换会话拒绝旧订阅尾事件", () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", StreamSource);
  const client = new QueryClient();
  const snapshot: Message[] = [
    { id: "m-1", role: "assistant", content: "", status: "processing" },
  ];
  const hook = renderHook(({ id, data }) => useChatStream(id, data), {
    initialProps: { id: "c-1", data: snapshot },
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  act(() => {
    for (let index = 0; index < 20; index++)
      StreamSource.all[0].send("token", index + 1, {
        message_id: "m-1",
        token: "字",
        offset: index,
      });
  });
  expect(hook.result.current[0].content).toBe("");
  act(() => {
    vi.advanceTimersByTime(60);
  });
  expect(hook.result.current).toHaveLength(1);
  expect(hook.result.current[0].content).toBe("字".repeat(20));
  act(() => {
    StreamSource.all[0].send("completed", 21, {
      message_id: "m-1",
      content: "完成回答",
    });
  });
  expect(hook.result.current[0]).toMatchObject({
    content: "完成回答",
    status: "completed",
  });
  hook.rerender({ id: "c-2", data: [] });
  expect(StreamSource.all[0].close).toHaveBeenCalledOnce();
  act(() => {
    StreamSource.all[0].send("token", 22, {
      message_id: "m-1",
      token: "旧会话尾巴",
      offset: 20,
    });
    vi.advanceTimersByTime(100);
  });
  expect(hook.result.current).toEqual([]);
  hook.unmount();
  client.clear();
});
