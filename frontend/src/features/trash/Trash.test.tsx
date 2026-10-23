import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Trash } from "./Trash";

const clients: QueryClient[] = [];
const counts = { document: 1, folder: 0, knowledge_base: 73 };
const deletedDocument = {
  id: "document-1",
  kind: "document",
  name: "实验记录.md",
  kb_id: "kb-1",
  kb_name: "研究资料",
  deleted_at: "2026-10-23T01:30:00Z",
};
const deletedBase = {
  id: "deleted-kb",
  kind: "knowledge_base",
  name: "旧的研究库",
  kb_id: "deleted-kb",
  kb_name: "旧的研究库",
  deleted_at: "2026-10-22T01:30:00Z",
  document_count: 12,
  folder_count: 3,
};

function renderTrash() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <Trash />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

it("已删除知识库在完整列表中展示，并使用对应的恢复接口", async () => {
  let restored = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      restored = true;
      return new Response(JSON.stringify({}));
    }
    const kind = new URL(path, "http://localhost").searchParams.get("kind");
    return new Response(
      JSON.stringify({
        items:
          kind === "knowledge_base"
            ? restored
              ? []
              : [deletedBase]
            : [deletedDocument],
        total: kind === "knowledge_base" ? (restored ? 0 : 1) : 1,
        counts: { ...counts, knowledge_base: restored ? 72 : 73 },
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  renderTrash();
  expect(await screen.findByText("实验记录.md")).toBeInTheDocument();
  expect(screen.queryByText("旧的研究库")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "知识库 73" }));
  const row = (await screen.findByText("旧的研究库")).closest("tr")!;
  expect(within(row).getByText("12 个文档 · 3 个文件夹")).toBeInTheDocument();
  expect(screen.getByText(/恢复知识库后可继续访问/)).toBeInTheDocument();
  await userEvent.click(
    within(row).getByRole("button", { name: "恢复 旧的研究库" }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/knowledge-bases/deleted-kb/restore",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(await screen.findByText("没有已删除的知识库")).toBeInTheDocument();
});

it("清空回收站必须最后确认，失败后保留内容并展示错误", async () => {
  const fetch = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(
          JSON.stringify({ detail: "还有任务正在执行，请稍后重试" }),
          { status: 409 },
        )
      : new Response(
          JSON.stringify({ items: [deletedDocument], total: 1, counts }),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  renderTrash();
  await screen.findByText("实验记录.md");
  await userEvent.click(screen.getByRole("button", { name: "清空回收站" }));
  let dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByText(/全部文档、文件夹和知识库/),
  ).toBeInTheDocument();
  expect(
    fetch.mock.calls.filter((call) => call[1]?.method === "POST"),
  ).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "清空回收站" }));
  dialog = screen.getByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "确认永久删除" }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/trash/purge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "all", confirm: true }),
      }),
    ),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "还有任务正在执行，请稍后重试",
  );
  expect(screen.getByText("实验记录.md")).toBeInTheDocument();
});

it("单项永久删除只提交选中的资源", async () => {
  let deleted = false;
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      deleted = true;
      return new Response(JSON.stringify({}));
    }
    return new Response(
      JSON.stringify({
        items: deleted ? [] : [deletedDocument],
        total: deleted ? 0 : 1,
        counts: { document: deleted ? 0 : 1, folder: 0, knowledge_base: 0 },
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  renderTrash();
  await screen.findByText("实验记录.md");
  await userEvent.click(
    screen.getByRole("button", { name: "永久删除 实验记录.md" }),
  );
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("实验记录.md")).toBeInTheDocument();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "确认永久删除" }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/trash/purge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "document",
          ids: ["document-1"],
          confirm: true,
        }),
      }),
    ),
  );
  expect(await screen.findByText("没有已删除的文档")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("原文件清理失败后，空回收站仍可再次清空以重试", async () => {
  const fetch = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ deleted: {}, pending_file_cleanup: 2 }))
      : new Response(
          JSON.stringify({
            items: [],
            total: 0,
            counts: { document: 0, folder: 0, knowledge_base: 0 },
            pending_file_cleanup: 2,
          }),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  renderTrash();
  expect(
    await screen.findByText(/有 2 个文件尚未彻底删除/),
  ).toBeInTheDocument();
  const clear = screen.getByRole("button", { name: "清空回收站" });
  expect(clear).toBeEnabled();
  await userEvent.click(clear);
  await userEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "确认永久删除",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "清空回收站" })).toBeEnabled();
  expect(fetch).toHaveBeenCalledWith(
    "/api/trash/purge",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ kind: "all", confirm: true }),
    }),
  );
});

it("分页和搜索使用服务器筛选，切换分类支持键盘", async () => {
  const fetch = vi.fn(async (path: string) => {
    const params = new URL(path, "http://localhost").searchParams;
    const page = params.get("page");
    const filter = params.get("q");
    return new Response(
      JSON.stringify({
        items: filter
          ? []
          : [
              {
                ...deletedDocument,
                id: `item-${page}`,
                name: `第${page}页资料.md`,
              },
            ],
        total: filter ? 0 : 31,
        counts,
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  renderTrash();
  await screen.findByText("第1页资料.md");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("第2页资料.md")).toBeInTheDocument();
  await userEvent.type(
    screen.getByRole("textbox", { name: "搜索已删除的内容" }),
    "项目 A",
  );
  expect(await screen.findByText("没有找到匹配的内容")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(
    "/api/trash?kind=document&q=%E9%A1%B9%E7%9B%AE+A&page=1&page_size=30",
    expect.anything(),
  );
  screen.getByRole("tab", { name: "文档 1" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "文件夹 0" })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
});
