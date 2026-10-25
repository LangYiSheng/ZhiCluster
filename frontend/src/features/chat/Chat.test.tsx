import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ComponentProps, ReactElement } from "react";
import { cleanup, render as renderUI, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Chat } from "./Chat";
const render = (element: ReactElement) =>
  renderUI(element, { wrapper: MemoryRouter });

function HistoryChat(props: ComponentProps<typeof Chat>) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLButtonElement | null>(
    null,
  );
  return (
    <>
      <button
        ref={setHistoryAnchor}
        aria-expanded={historyOpen}
        onClick={() => setHistoryOpen((value) => !value)}
      >
        历史
      </button>
      <Chat
        {...props}
        historyAnchor={historyAnchor}
        historyOpen={historyOpen}
        onHistoryOpenChange={setHistoryOpen}
      />
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it("历史与范围为锚定的非模态卡片，Esc还原焦点且点击外部不阻挡输入", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]")),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  render(
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const historyTrigger = screen.getByRole("button", { name: "历史" });
  await user.click(historyTrigger);
  const history = screen.getByRole("dialog", { name: "历史对话" });
  expect(history).toHaveClass("popover-content", "history-popover");
  expect(history).toHaveAttribute("data-align", "end");
  expect(history).not.toHaveAttribute("aria-modal", "true");
  expect(document.querySelector(".dialog-overlay")).toBeNull();
  expect(document.body.style.pointerEvents).toBe("");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(historyTrigger).toHaveFocus());

  const scopeTrigger = screen.getByRole("button", { name: "调整问答范围" });
  await user.click(scopeTrigger);
  const scope = screen.getByRole("dialog", { name: "问答范围" });
  expect(scope).toHaveClass("popover-content", "scope-popover");
  expect(scope).toHaveAttribute("data-align", "start");
  expect(scope).not.toHaveAttribute("aria-modal", "true");
  expect(scopeTrigger).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByLabelText("知识库问题"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("知识库问题")).toHaveFocus();
  await user.type(screen.getByLabelText("知识库问题"), "继续提问");
  expect(screen.getByLabelText("知识库问题")).toHaveValue("继续提问");

  await user.click(historyTrigger);
  await user.click(historyTrigger);
  expect(historyTrigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("草稿在页面卸载和会话切换后按知识库与会话隔离恢复", async () => {
  localStorage.setItem("conversation:kb-1", "c-1");
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("/messages")
              ? []
              : [
                  { id: "c-1", title: "第一会话", scope: { kb_ids: ["kb-1"] } },
                  { id: "c-2", title: "第二会话", scope: { kb_ids: ["kb-1"] } },
                ],
          ),
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  const view = () => (
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>
  );
  const mounted = render(view());
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "历史" }));
  await screen.findByRole("button", { name: "打开对话：第二会话" });
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await user.type(screen.getByLabelText("知识库问题"), "第一会话未发送的内容");
  await user.click(screen.getByRole("button", { name: "历史" }));
  await user.click(screen.getByRole("button", { name: "打开对话：第二会话" }));
  expect(screen.getByLabelText("知识库问题")).toHaveValue("");
  await user.type(screen.getByLabelText("知识库问题"), "第二会话草稿");
  await user.click(screen.getByRole("button", { name: "历史" }));
  await user.click(screen.getByRole("button", { name: "打开对话：第一会话" }));
  expect(screen.getByLabelText("知识库问题")).toHaveValue(
    "第一会话未发送的内容",
  );
  mounted.unmount();
  render(view());
  expect(screen.getByLabelText("知识库问题")).toHaveValue(
    "第一会话未发送的内容",
  );
});

it("新会话发送失败保留输入，发送成功才清理对应草稿", async () => {
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  let rejected = true;
  let createdCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST" && path.endsWith("/messages"))
        return rejected
          ? new Response(
              JSON.stringify({ code: "test_failure", message: "发送失败" }),
              { status: 503 },
            )
          : new Response(JSON.stringify({ id: "message-1", status: "queued" }));
      if (init?.method === "POST") {
        createdCount++;
        return new Response(JSON.stringify({ id: "c-new", title: "新会话" }));
      }
      return new Response("[]");
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  render(
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("知识库问题"),
    "网络失败也要保留这句话",
  );
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  await vi.waitFor(() =>
    expect(screen.getByLabelText("知识库问题")).toBeEnabled(),
  );
  expect(screen.getByLabelText("知识库问题")).toHaveValue(
    "网络失败也要保留这句话",
  );
  expect(localStorage.getItem("conversation:kb-1")).toBe("c-new");
  rejected = false;
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  await vi.waitFor(() =>
    expect(screen.getByLabelText("知识库问题")).toHaveValue(""),
  );
  expect(
    sessionStorage.getItem("zhicluster:draft:v1:chat:kb-1:new"),
  ).toBeNull();
  expect(createdCount).toBe(1);
});
it("受控响应验证processing禁发、真实引用序号与持久会话范围", async () => {
  localStorage.setItem("conversation:kb-1", "c-1");
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("/messages")
              ? [
                  {
                    id: "m-1",
                    role: "assistant",
                    content: "已生成的局部回答[S3]",
                    status: "processing",
                    citations: [
                      {
                        chunk_id: "chunk-1",
                        document_id: "doc-1",
                        ordinal: 3,
                        document_name: "已删除的来源",
                        available: false,
                        anchors: { page_start: 2 },
                      },
                    ],
                  },
                ]
              : [
                  {
                    id: "c-1",
                    title: "恢复的会话",
                    scope: {
                      kb_ids: ["kb-1", "kb-2"],
                      folder_ids: ["f-1"],
                      tag_ids: ["t-1"],
                      include_descendants: true,
                    },
                  },
                ],
          ),
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  render(
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb, { ...kb, id: "kb-2", name: "第二知识库" }]}
        folders={[
          {
            id: "f-1",
            name: "保存的文件夹",
            kb_id: "kb-1",
            parent_id: null,
            version: 1,
          },
        ]}
        tags={[{ id: "t-1", name: "保存的标签", color: "#6366f1", version: 1 }]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("正在查找资料");
  expect(screen.getByText("3", { selector: ".source-number" })).toBeVisible();
  expect(screen.getByRole("button", { name: "来源不可用 3" })).toBeDisabled();
  expect(screen.queryByText("已删除的来源")).not.toBeInTheDocument();
  expect(screen.getByText(/问答范围 · 2 个知识库/)).toBeVisible();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("知识库问题"), "处理中不能重复发送");
  expect(screen.getByRole("button", { name: "发送问题" })).toBeDisabled();
  await user.click(screen.getByText(/问答范围 · 2 个知识库/));
  expect(screen.getByLabelText("保存的文件夹")).toBeChecked();
  expect(screen.getByLabelText("保存的文件夹")).toBeDisabled();
});

it("旧实例发送完成不会清掉重开知识库后输入的新草稿", async () => {
  let finish: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST" && path.endsWith("/messages")) return pending;
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({ id: "created-conversation", title: "new" }),
        );
      return new Response("[]");
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const kb = { id: "race-kb", name: "研究库", description: "", version: 1 };
  const view = (key: string) => (
    <QueryClientProvider client={client}>
      <HistoryChat
        key={key}
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>
  );
  const mounted = render(view("first"));
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("知识库问题"), "已提交的问题");
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  mounted.rerender(view("reopened"));
  await user.clear(screen.getByLabelText("知识库问题"));
  await user.type(screen.getByLabelText("知识库问题"), "重开后新问题");
  finish(new Response(JSON.stringify({ id: "message", status: "queued" })));
  await vi.waitFor(() => expect(client.isMutating()).toBe(0));
  expect(sessionStorage.getItem("zhicluster:draft:v1:chat:race-kb:new")).toBe(
    "重开后新问题",
  );
  mounted.rerender(view("third"));
  expect(screen.getByLabelText("知识库问题")).toHaveValue("重开后新问题");
  client.clear();
});

it("历史切换运行中的会话只重连事件订阅，新建对话恢复独立草稿", async () => {
  localStorage.setItem("conversation:kb-1", "c-1");
  sessionStorage.setItem("zhicluster:draft:v1:chat:kb-1:new", "新对话未发草稿");
  const sources: { path: string; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    "EventSource",
    class {
      close = vi.fn();
      constructor(path: string) {
        sources.push({ path, close: this.close });
      }
      addEventListener() {}
    },
  );
  const fetchMock = vi.fn<
    (path: string, init?: RequestInit) => Promise<Response>
  >(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.endsWith("/messages")
            ? [
                {
                  id: "m-1",
                  role: "assistant",
                  content: "正在回答",
                  status: "running",
                },
              ]
            : [
                {
                  id: "c-1",
                  title: "运行中的会话",
                  scope: { kb_ids: ["kb-1"] },
                },
                { id: "c-2", title: "另一段会话", scope: { kb_ids: ["kb-1"] } },
              ],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  render(
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await screen.findByText("正在回答");
  await user.type(screen.getByLabelText("知识库问题"), "运行中保留的草稿");
  await user.click(screen.getByRole("button", { name: "历史" }));
  expect(
    screen.getByRole("button", { name: "打开对话：运行中的会话" }),
  ).toHaveAttribute("aria-current", "true");
  await user.click(
    screen.getByRole("button", { name: "打开对话：另一段会话" }),
  );
  expect(sources[0].close).toHaveBeenCalledOnce();
  expect(sources.at(-1)?.path).toContain("/c-2/events");
  expect(screen.getByLabelText("知识库问题")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "历史" }));
  await user.click(
    screen.getByRole("button", { name: "打开对话：运行中的会话" }),
  );
  expect(screen.getByLabelText("知识库问题")).toHaveValue("运行中保留的草稿");
  await user.click(screen.getByRole("button", { name: "历史" }));
  await user.click(screen.getByRole("button", { name: "新建对话" }));
  expect(screen.getByLabelText("知识库问题")).toHaveValue("新对话未发草稿");
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("删除当前会话成功后回到新草稿，历史空态仍能新建", async () => {
  localStorage.setItem("conversation:kb-1", "c-1");
  sessionStorage.setItem("zhicluster:draft:v1:chat:kb-1:new", "待发送的新草稿");
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return new Response("{}");
      }
      return new Response(
        JSON.stringify(
          path.endsWith("/messages") || deleted
            ? []
            : [{ id: "c-1", title: "待删除会话", scope: { kb_ids: ["kb-1"] } }],
        ),
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  render(
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "历史" }));
  await user.click(
    await screen.findByRole("button", { name: "对话操作：待删除会话" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "删除对话" }));
  await screen.findByText("还没有历史对话");
  expect(localStorage.getItem("conversation:kb-1")).toBe("");
  await user.click(screen.getByRole("button", { name: "新建对话" }));
  expect(screen.getByLabelText("知识库问题")).toHaveValue("待发送的新草稿");
});

it("范围面板按选择创建多库会话，取消当前库会清掉其文件夹与标签范围", async () => {
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ path, body });
        return new Response(
          JSON.stringify(
            path.endsWith("/messages")
              ? { id: "m-1", status: "queued" }
              : { id: "c-new", scope: body.scope },
          ),
        );
      }
      return new Response("[]");
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  render(
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb, { ...kb, id: "kb-2", name: "第二知识库" }]}
        folders={[
          {
            id: "f-1",
            kb_id: "kb-1",
            parent_id: null,
            name: "研究目录",
            version: 1,
          },
        ]}
        tags={[{ id: "t-1", name: "检索", color: "#333333", version: 1 }]}
        onCitation={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("知识库问题"), "按范围查找");
  await user.click(screen.getByRole("button", { name: "调整问答范围" }));
  await user.click(screen.getByRole("tab", { name: /文件夹/ }));
  await user.click(screen.getByLabelText("研究目录"));
  await user.click(screen.getByRole("tab", { name: /标签/ }));
  await user.click(screen.getByLabelText("检索", { exact: true }));
  await user.click(screen.getByRole("tab", { name: /知识库/ }));
  await user.click(screen.getByLabelText("研究库", { exact: true }));
  expect(screen.getByLabelText("研究目录")).not.toBeChecked();
  expect(screen.getByLabelText("研究目录")).toBeDisabled();
  expect(screen.getByLabelText("检索", { exact: true })).not.toBeChecked();
  expect(screen.getByLabelText("检索", { exact: true })).toBeDisabled();
  await user.click(screen.getByLabelText("第二知识库"));
  await user.click(screen.getByLabelText("研究库", { exact: true }));
  await user.click(screen.getByRole("tab", { name: /文件夹/ }));
  await user.click(screen.getByLabelText("研究目录"));
  await user.click(screen.getByLabelText("包含子文件夹"));
  await user.click(screen.getByRole("tab", { name: /标签/ }));
  await user.click(screen.getByLabelText("检索", { exact: true }));
  await user.click(screen.getByRole("button", { name: "完成" }));
  expect(
    screen.getByRole("button", { name: "调整问答范围" }),
  ).toHaveTextContent("2 个知识库");
  expect(
    document.querySelector(".composer-scope-label"),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "选择模型与思考模式" }));
  await user.click(screen.getByRole("button", { name: "思考" }));
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].body.scope).toEqual({
    kb_ids: ["kb-2", "kb-1"],
    folder_ids: ["f-1"],
    tag_ids: ["t-1"],
    include_descendants: false,
  });
  expect(requests[1].body.retrieval_mode).toBe("model");
  expect(requests[0].body.kb_id).toBe("kb-1");
  expect(requests[0].body.scope).not.toHaveProperty("retrieval_mode");
});

it("离开聊天会关闭Portal弹窗，返回时保留草稿且不重开范围、历史或重命名", async () => {
  localStorage.setItem("conversation:kb-1", "c-1");
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("/messages")
              ? []
              : [{ id: "c-1", title: "保留会话", scope: { kb_ids: ["kb-1"] } }],
          ),
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  const view = (active: boolean) => (
    <QueryClientProvider client={client}>
      <HistoryChat
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
        active={active}
      />
    </QueryClientProvider>
  );
  const mounted = render(view(true));
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("知识库问题"), "跨页保留草稿");
  await user.click(screen.getByRole("button", { name: "调整问答范围" }));
  expect(screen.getByRole("dialog", { name: "问答范围" })).toBeVisible();
  mounted.rerender(view(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  mounted.rerender(view(true));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("知识库问题")).toHaveValue("跨页保留草稿");
  await user.click(screen.getByRole("button", { name: "历史" }));
  expect(screen.getByRole("dialog", { name: "历史对话" })).toBeVisible();
  mounted.rerender(view(false));
  mounted.rerender(view(true));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "历史" }));
  await user.click(screen.getByRole("button", { name: "对话操作：保留会话" }));
  await user.click(screen.getByRole("menuitem", { name: "重命名" }));
  expect(screen.getByRole("dialog", { name: "重命名对话" })).toBeVisible();
  mounted.rerender(view(false));
  mounted.rerender(view(true));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("知识库问题")).toHaveValue("跨页保留草稿");
});
