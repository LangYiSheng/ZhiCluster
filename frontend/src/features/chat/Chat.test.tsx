import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Chat } from "./Chat";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
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
      <Chat
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
  await screen.findByRole("option", { name: "第二会话" });
  await user.type(screen.getByLabelText("知识库问题"), "第一会话未发送的内容");
  await user.selectOptions(screen.getByLabelText("切换对话"), "c-2");
  expect(screen.getByLabelText("知识库问题")).toHaveValue("");
  await user.type(screen.getByLabelText("知识库问题"), "第二会话草稿");
  await user.selectOptions(screen.getByLabelText("切换对话"), "c-1");
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
      if (init?.method === "POST")
        return new Response(JSON.stringify({ id: "c-new", title: "新会话" }));
      return new Response("[]");
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
  render(
    <QueryClientProvider client={client}>
      <Chat
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
  rejected = false;
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  await vi.waitFor(() =>
    expect(screen.getByLabelText("知识库问题")).toHaveValue(""),
  );
  expect(
    sessionStorage.getItem("zhicluster:draft:v1:chat:kb-1:new"),
  ).toBeNull();
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
                    content: "",
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
      <Chat
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
  await screen.findByText("正在查阅知识库…");
  expect(screen.getByText("3", { selector: ".source-number" })).toBeVisible();
  expect(screen.getByRole("button", { name: /已删除的来源/ })).toBeDisabled();
  expect(screen.getByText(/问答范围 · 2 个知识库/)).toBeVisible();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("知识库问题"), "处理中不能重复发送");
  expect(screen.getByRole("button", { name: "发送问题" })).toBeDisabled();
  await user.click(screen.getByText(/问答范围 · 2 个知识库/));
  expect(screen.getByLabelText("保存的文件夹")).toBeChecked();
  expect(screen.getByLabelText("保存的文件夹")).toBeDisabled();
});
