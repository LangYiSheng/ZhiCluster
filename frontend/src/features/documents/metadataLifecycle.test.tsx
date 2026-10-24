import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DocumentsPane } from "./DocumentsPane";
import { Library } from "../kb/Library";
import type { Document } from "../../lib/api";

const kb = { id: "a", name: "知识库甲", description: "", version: 1 };
const other = { ...kb, id: "b", name: "知识库乙" };
const doc: Document = {
  id: "doc-a",
  kb_id: kb.id,
  folder_id: null,
  display_name: "甲.txt",
  original_filename: "甲.txt",
  ext: "txt",
  size_bytes: 1,
  version: 1,
  parse_status: "ready",
  index_status: "ready",
  summary_status: "ready",
  classification_status: "ready",
  created_at: "2026-10-24",
};
const clients: QueryClient[] = [];
function client() {
  const result = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(result);
  return result;
}
afterEach(() => {
  cleanup();
  clients.forEach((value) => value.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

it("删除资料等待列表协调后关闭确认，来源消失时回到资料区域", async () => {
  let deleted = false;
  let resolveRefresh: (value: Response) => void = () => {};
  const refreshed = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/documents/batch") && init?.method === "POST") {
      deleted = true;
      return new Response(JSON.stringify({ results: [] }));
    }
    if (path.includes("/documents") && !init?.method) {
      if (deleted) return refreshed;
      return new Response(
        JSON.stringify({ items: [doc], total: 1, page_size: 50 }),
      );
    }
    return new Response("[]");
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <MemoryRouter>
      <QueryClientProvider client={client()}>
        <main data-focus-return-scope tabIndex={-1}>
          <DocumentsPane
            kb={kb}
            folders={[]}
            tags={[]}
            trash={false}
            onOpen={vi.fn()}
            selectedId=""
          />
        </main>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByText("甲.txt");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "甲.txt文档菜单" }));
  await user.click(screen.getByRole("menuitem", { name: "移到回收站" }));
  await user.click(screen.getByRole("button", { name: "确认移到回收站" }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(
        ([path, init]) => path.includes("/documents") && !init?.method,
      ),
    ).toHaveLength(2),
  );
  expect(screen.getByRole("dialog", { name: "移到回收站" })).toBeVisible();
  resolveRefresh(
    new Response(JSON.stringify({ items: [], total: 0, page_size: 50 })),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
});

it("旧文档保存成功不关闭新文档的编辑草稿", async () => {
  let resolveSave: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  const fetch = vi.fn(async (path: string, init?: RequestInit) =>
    init?.method === "PATCH"
      ? pending
      : new Response(
          JSON.stringify(
            path.includes("/documents")
              ? {
                  items: [doc, { ...doc, id: "doc-b", display_name: "乙.txt" }],
                  total: 2,
                  page_size: 50,
                }
              : [],
          ),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <MemoryRouter>
      <QueryClientProvider client={client()}>
        <DocumentsPane
          kb={kb}
          folders={[]}
          tags={[]}
          trash={false}
          onOpen={vi.fn()}
          selectedId=""
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByText("甲.txt");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "甲.txt文档菜单" }));
  await user.click(screen.getByRole("menuitem", { name: "重命名" }));
  await user.clear(screen.getByLabelText("名称"));
  await user.type(screen.getByLabelText("名称"), "甲已保存.txt");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "乙.txt文档菜单" }));
  await user.click(screen.getByRole("menuitem", { name: "重命名" }));
  await user.clear(screen.getByLabelText("名称"));
  await user.type(screen.getByLabelText("名称"), "乙的未保存草稿.txt");
  resolveSave(
    new Response(
      JSON.stringify({ ...doc, display_name: "甲已保存.txt", version: 2 }),
    ),
  );
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(
        ([path, init]) => path.includes("/documents") && !init?.method,
      ).length,
    ).toBeGreaterThan(1),
  );
  expect(screen.getByRole("dialog", { name: "重命名文档" })).toBeVisible();
  expect(screen.getByLabelText("名称")).toHaveValue("乙的未保存草稿.txt");
});

it("旧知识库保存成功不会把用户从新选中的库切回", async () => {
  let resolveSave: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => pending),
  );
  const selected = vi.fn();
  const qc = client();
  const view = (id: string) => (
    <QueryClientProvider client={qc}>
      <Library
        knowledgeBases={[kb, other]}
        kbId={id}
        onSelect={selected}
        trash={false}
      />
    </QueryClientProvider>
  );
  const mounted = render(view(kb.id));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "知识库甲菜单" }));
  await user.click(screen.getByRole("menuitem", { name: "修改名称与描述" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "知识库乙" }));
  mounted.rerender(view(other.id));
  selected.mockClear();
  resolveSave(new Response(JSON.stringify({ ...kb, version: 2 })));
  await waitFor(() => expect(qc.isMutating()).toBe(0));
  expect(selected).not.toHaveBeenCalled();
  expect(screen.getByText("当前知识库 知识库乙")).toBeInTheDocument();
});

it("仍在当前创建弹窗时保存成功会选中新知识库", async () => {
  const created = { ...kb, id: "new-kb", name: "新资料库" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(created))),
  );
  const selected = vi.fn();
  render(
    <QueryClientProvider client={client()}>
      <Library
        knowledgeBases={[kb]}
        kbId={kb.id}
        onSelect={selected}
        trash={false}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "新建知识库" }));
  await user.type(screen.getByLabelText("名称"), "新资料库");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith("new-kb"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("旧知识库删除响应不关闭后来打开的其他库确认", async () => {
  let finish: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi.fn(async () => pending);
  vi.stubGlobal("fetch", fetch);
  const qc = client();
  render(
    <QueryClientProvider client={qc}>
      <Library
        knowledgeBases={[kb, other]}
        kbId={kb.id}
        onSelect={vi.fn()}
        trash={false}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "知识库甲菜单" }));
  await user.click(screen.getByRole("menuitem", { name: "删除知识库" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "知识库乙菜单" }));
  await user.click(screen.getByRole("menuitem", { name: "删除知识库" }));
  finish(new Response("{}"));
  await waitFor(() => expect(qc.isMutating()).toBe(0));
  expect(fetch).toHaveBeenCalledWith(
    "/api/knowledge-bases/a",
    expect.objectContaining({ method: "DELETE" }),
  );
  expect(screen.getByRole("dialog", { name: "确认删除" })).toHaveTextContent(
    "知识库乙",
  );
});
