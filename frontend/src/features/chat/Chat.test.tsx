import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Chat } from "./Chat";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
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
