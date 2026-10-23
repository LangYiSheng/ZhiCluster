import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ModelPicker } from "./ModelPicker";
import type {
  ConnectionConfig,
  ConnectionDraft,
  ModelScope,
} from "../../lib/settings";

const saved: ConnectionConfig = {
  base_url: "https://provider.example/v1",
  model: "saved-model",
  api_key_configured: true,
  timeout_seconds: 60,
  max_retries: 2,
};
const connection: ConnectionDraft = {
  base_url: saved.base_url,
  model: saved.model,
  timeout_seconds: saved.timeout_seconds,
  max_retries: saved.max_retries,
};
type PickerProps = {
  scope?: ModelScope;
  draft?: ConnectionDraft;
  loaded?: ConnectionConfig;
  revision?: number;
};
function Picker({
  scope = "llm",
  draft = connection,
  loaded = saved,
  revision = 7,
}: PickerProps) {
  const [manual, setManual] = useState(false);
  return (
    <ModelPicker
      scope={scope}
      connection={draft}
      saved={loaded}
      revision={revision}
      manual={manual}
      onManualChange={setManual}
      onChange={change}
    />
  );
}
const change = vi.fn();
const response = (ids: string[]) =>
  new Response(JSON.stringify({ models: ids.map((id) => ({ id })) }));
const deferred = () => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
async function tick(ms = 800) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  change.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("模型目录选择", () => {
  it("聊天和向量独立去抖拉取，省略留空的已存密钥并保留目录外的当前模型", async () => {
    const fetch = vi.fn(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return response([body.scope === "llm" ? "chat-one" : "vector-one"]);
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <>
        <section aria-label="chat">
          <Picker />
        </section>
        <section aria-label="vector">
          <Picker scope="embedding" />
        </section>
      </>,
    );
    await tick(799);
    expect(fetch).not.toHaveBeenCalled();
    await tick(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      const body = JSON.parse(String(init.body));
      expect(Object.keys(body.draft)).toEqual([body.scope]);
      expect(body.draft[body.scope]).toEqual({ base_url: saved.base_url });
    }
    expect(
      within(screen.getByRole("region", { name: "chat" })).getByRole(
        "combobox",
        { name: "模型名称" },
      ),
    ).toHaveTextContent("saved-model（当前填写）");
    expect(screen.getAllByText("已获取 1 个模型，请按用途选择。")).toHaveLength(
      2,
    );
    expect(change).not.toHaveBeenCalled();
  });

  it("模型选择与非连接字段修改不重新获取目录", async () => {
    const fetch = vi.fn(async () => response(["chat-one", "chat-two"]));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<Picker />);
    await tick();
    rerender(
      <Picker
        draft={{ ...connection, model: "chat-one", timeout_seconds: 120 }}
      />,
    );
    await tick(1200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("combobox", { name: "模型名称" }),
    ).toHaveTextContent("chat-one");
  });

  it("修改地址立即废弃旧目录和在途响应，换地址后不会复用保存密钥", async () => {
    const old = deferred();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(response(["new-model"]));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<Picker />);
    await tick();
    const oldSignal = fetch.mock.calls[0][1].signal as AbortSignal;
    const newDraft = { ...connection, base_url: "https://new.example/v1" };
    rerender(<Picker draft={newDraft} />);
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByText(/服务地址已改变/)).toBeVisible();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => old.resolve(response(["old-late-model"])));
    expect(screen.queryByText(/已获取/)).not.toBeInTheDocument();
    rerender(<Picker draft={{ ...newDraft, api_key: "new-draft-key" }} />);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toEqual({
      scope: "llm",
      draft: { llm: { base_url: newDraft.base_url, api_key: "new-draft-key" } },
    });
    expect(screen.getByText("已获取 1 个模型，请按用途选择。")).toBeVisible();
    expect(document.body.textContent).not.toContain("new-draft-key");
  });

  it("旧失败不能覆盖新成功，刷新后再次改Key仍然去抖", async () => {
    const old = deferred();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(response(["new-model"]));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(
      <Picker draft={{ ...connection, api_key: "first-key" }} />,
    );
    await tick();
    rerender(<Picker draft={{ ...connection, api_key: "second-key" }} />);
    await tick();
    await act(async () => old.reject(new Error("old failure")));
    expect(screen.getByText("已获取 1 个模型，请按用途选择。")).toBeVisible();
    expect(screen.queryByText(/old failure/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新聊天模型列表" }));
    await tick(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    rerender(<Picker draft={{ ...connection, api_key: "third-key" }} />);
    await tick(799);
    expect(fetch).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("不支持目录时允许手动填写和刷新，失败不会改动模型", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "model_list_unsupported",
              message: "服务不支持模型列表",
            },
          }),
          { status: 502 },
        ),
      )
      .mockResolvedValue(response(["later-model"]));
    vi.stubGlobal("fetch", fetch);
    render(<Picker />);
    await tick();
    expect(screen.getByText(/服务不支持模型列表/)).toBeVisible();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
    fireEvent.change(screen.getByRole("textbox", { name: "模型名称" }), {
      target: { value: "manual-model" },
    });
    expect(change).toHaveBeenLastCalledWith("manual-model");
    fireEvent.click(screen.getByRole("button", { name: "刷新聊天模型列表" }));
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: "从列表选择" }));
    expect(
      screen.getByRole("combobox", { name: "模型名称" }),
    ).toHaveTextContent("saved-model（当前填写）");
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("清除密钥和组件卸载会取消请求，保存新Key后清空输入可复用保存Key", async () => {
    const pending = deferred();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(["first-model"]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response(["saved-key-model"]));
    vi.stubGlobal("fetch", fetch);
    const { rerender, unmount } = render(
      <Picker draft={{ ...connection, api_key: "unsaved-key" }} />,
    );
    await tick();
    rerender(<Picker draft={{ ...connection, clear_api_key: true }} />);
    expect(
      screen.getByRole("button", { name: "刷新聊天模型列表" }),
    ).toBeDisabled();
    expect(screen.queryByText(/已获取/)).not.toBeInTheDocument();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    rerender(<Picker draft={connection} revision={8} />);
    await tick();
    expect(
      JSON.parse(String(fetch.mock.calls[1][1].body)).draft.llm,
    ).not.toHaveProperty("api_key");
    const signal = fetch.mock.calls[1][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response(["late-model"])));
    expect(screen.queryByText(/late-model/)).not.toBeInTheDocument();
  });
});
