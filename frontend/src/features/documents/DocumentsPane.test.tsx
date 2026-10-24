import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentsPane } from "./DocumentsPane";
import { TagManager } from "./TagManager";
import type { Document, Folder, Tag } from "../../lib/api";
function render(ui: ReactElement) {
  return renderView(ui, { wrapper: MemoryRouter });
}

const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
const tag: Tag = {
  id: "tag-1",
  name: "研究",
  color: "#6366f1",
  aliases: ["Research"],
  version: 4,
};
const doc: Document = {
  id: "doc-1",
  kb_id: kb.id,
  folder_id: null,
  display_name: "研究记录.txt",
  original_filename: "研究记录.txt",
  ext: "txt",
  size_bytes: 42,
  version: 1,
  parse_status: "ready",
  index_status: "ready",
  summary_status: "ready",
  classification_status: "ready",
  created_at: "2026-10-23T00:00:00Z",
  tag_ids: [tag.id],
};
const clients: QueryClient[] = [];
const folder: Folder = {
  id: "folder-a",
  kb_id: kb.id,
  parent_id: null,
  name: "投递目录",
  version: 1,
};
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(value);
  return value;
}
afterEach(() => {
  cleanup();
  clients.forEach((value) => value.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

it("拖放上传及重复副本始终保存到落点目录", async () => {
  const targets: (FormDataEntryValue | null)[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("/uploads")) {
      const body = init?.body as FormData;
      targets.push(body.get("folder_id"));
      return new Response(
        JSON.stringify({
          items: [
            {
              status:
                body.get("duplicate_policy") === "copy"
                  ? "queued"
                  : "duplicate",
              document: doc,
            },
          ],
        }),
      );
    }
    return new Response(
      JSON.stringify(
        path.includes("/documents")
          ? { items: [doc], total: 1, page_size: 50 }
          : [],
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[folder]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await screen.findByText(doc.display_name);
  fireEvent.drop(
    screen.getByRole("button", { name: folder.name }).closest(".folder-row")!,
    {
      dataTransfer: {
        files: [new File(["原文"], "拖放.txt", { type: "text/plain" })],
        getData: () => "",
      },
    },
  );
  await screen.findByRole("dialog", { name: "检测到相同内容" });
  await userEvent.click(screen.getByRole("button", { name: "保留副本" }));
  await waitFor(() => expect(targets).toHaveLength(2));
  expect(targets).toEqual([folder.id, folder.id]);
});

it.each(["下一页", "未分类", "文件类型筛选", "处理状态筛选"])(
  "切换%s清除原视图的勾选",
  async (control) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (path: string) =>
          new Response(
            JSON.stringify(
              path.includes("/documents")
                ? { items: [doc], total: 51, page_size: 50 }
                : [],
            ),
          ),
      ),
    );
    render(
      <QueryClientProvider client={client()}>
        <DocumentsPane
          kb={kb}
          folders={[]}
          tags={[]}
          trash={false}
          onOpen={vi.fn()}
          selectedId=""
        />
      </QueryClientProvider>,
    );
    await screen.findByText(doc.display_name);
    await userEvent.click(
      screen.getByRole("checkbox", { name: `选择 ${doc.display_name}` }),
    );
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
    if (control.endsWith("筛选")) {
      await userEvent.click(screen.getByRole("combobox", { name: control }));
      await userEvent.click(
        screen.getByRole("option", {
          name: control === "文件类型筛选" ? "PDF" : "处理失败",
        }),
      );
    } else await userEvent.click(screen.getByRole("button", { name: control }));
    expect(screen.queryByText("已选 1 项")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "批量操作" }),
    ).not.toBeInTheDocument();
  },
);

it("末页总量收缩后回到仍存在的页", async () => {
  let total = 51;
  const fetch = vi.fn(async (path: string) => {
    const page = new URL(path, "http://localhost").searchParams.get("page");
    return new Response(
      JSON.stringify(
        path.includes("/documents")
          ? {
              items: page === "2" && total <= 50 ? [] : [doc],
              total,
              page_size: 50,
            }
          : [],
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const qc = client();
  render(
    <QueryClientProvider client={qc}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await screen.findByText(doc.display_name);
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("2 / 2");
  total = 50;
  await qc.invalidateQueries({ queryKey: ["documents"] });
  await waitFor(() =>
    expect(
      fetch.mock.calls
        .filter(([path]) => path.includes("/documents"))
        .at(-1)?.[0],
    ).toContain("page=1"),
  );
  await waitFor(() => {
    expect(screen.getByText(doc.display_name)).toBeVisible();
    expect(screen.queryByText("这里还没有文档")).not.toBeInTheDocument();
  });
});

it("隐藏资料区不发起文档或任务查询", async () => {
  const fetch = vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.includes("/documents")
            ? { items: [], total: 0, page_size: 50 }
            : [],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[]}
        trash={false}
        active={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetch).not.toHaveBeenCalled();
});

it("资料页按可见文档读取当前任务，并显示整库准确统计", async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.includes("/documents"))
      return new Response(
        JSON.stringify({ items: [doc], total: 848, page_size: 50 }),
      );
    if (path.includes("/ingestion/jobs/page"))
      return new Response(
        JSON.stringify({
          items: [],
          total: 848,
          page: 1,
          page_size: 1,
          counts: { all: 848, active: 0, attention: 848, completed: 0 },
        }),
      );
    return new Response(
      JSON.stringify([
        {
          id: "old-document-job",
          document_id: doc.id,
          status: "partial_ready",
          stage: "completed",
          progress: 100,
          attempts: 1,
        },
      ]),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await screen.findByText("任务待处理");
  expect(
    await screen.findByRole("link", { name: /848 项待处理/ }),
  ).toBeInTheDocument();
  expect(
    fetch.mock.calls.some(
      ([path]) =>
        path.includes("document_ids=doc-1") && path.includes("view=current"),
    ),
  ).toBe(true);
});

it("其他知识库的目录拖到根目录时不修改源目录", async () => {
  const fetch = vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.includes("/documents")
            ? { items: [doc], total: 1, page_size: 50 }
            : [],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[folder]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await screen.findByText(doc.display_name);
  fireEvent.drop(document.querySelector(".folder-root-drop")!, {
    dataTransfer: {
      files: [],
      getData: (type: string) =>
        type === "application/x-zhicluster-folder" ? "foreign-folder" : "",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    fetch.mock.calls.some(([path]) => path.includes("/folders/foreign-folder")),
  ).toBe(false);
});

it("轮询后消失的文档不再进入勾选与批量操作", async () => {
  let items = [doc];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.includes("/documents")
              ? { items, total: 1, page_size: 50 }
              : [],
          ),
        ),
    ),
  );
  const qc = client();
  render(
    <QueryClientProvider client={qc}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await screen.findByText(doc.display_name);
  await userEvent.click(
    screen.getByRole("checkbox", { name: `选择 ${doc.display_name}` }),
  );
  items = [{ ...doc, id: "doc-new", display_name: "另一个文档.txt" }];
  await qc.invalidateQueries({ queryKey: ["documents"] });
  await screen.findByText("另一个文档.txt");
  expect(
    screen.queryByRole("button", { name: "批量操作" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("已选 1 项")).not.toBeInTheDocument();
});

it("当前文件夹被删除后自动回到全部文档", async () => {
  let removed = false;
  const fetch = vi.fn(async (path: string) => {
    if (path.includes("/documents")) {
      if (
        removed &&
        new URL(path, "http://localhost").searchParams.get("folder_id")
      )
        return new Response(
          JSON.stringify({
            error: { code: "invalid_folder", message: "目录已删除" },
          }),
          { status: 400 },
        );
      return new Response(
        JSON.stringify({ items: [doc], total: 1, page_size: 50 }),
      );
    }
    return new Response("[]");
  });
  vi.stubGlobal("fetch", fetch);
  const qc = client();
  render(
    <QueryClientProvider client={qc}>
      <DocumentsPane
        kb={kb}
        folders={[folder]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await screen.findByText(doc.display_name);
  await userEvent.click(screen.getByRole("button", { name: folder.name }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([path]) => path.includes("folder_id=folder-a")),
    ).toBe(true),
  );
  removed = true;
  await qc.invalidateQueries({ queryKey: ["documents"] });
  await waitFor(() =>
    expect(
      fetch.mock.calls
        .filter(([path]) => path.includes("/documents"))
        .at(-1)?.[0],
    ).not.toContain("folder_id="),
  );
  await waitFor(() =>
    expect(
      document.querySelector(".document-navigation .selected"),
    ).toHaveTextContent("全部文档"),
  );
});

it("上传请求未完成时不并发覆盖确认，隐藏再打开也不重开旧确认", async () => {
  let resolveUpload: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    resolveUpload = resolve;
  });
  const fetch = vi.fn(async (path: string) =>
    path.includes("/uploads")
      ? pending
      : new Response(
          JSON.stringify(
            path.includes("/documents")
              ? { items: [doc], total: 1, page_size: 50 }
              : [],
          ),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  const qc = client();
  const view = (active: boolean) => (
    <QueryClientProvider client={qc}>
      <DocumentsPane
        kb={kb}
        folders={[folder]}
        tags={[]}
        trash={false}
        active={active}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>
  );
  const mounted = render(view(true));
  await screen.findByText(doc.display_name);
  const transfer = {
    files: [new File(["原文"], "慢上传.txt", { type: "text/plain" })],
    getData: () => "",
  };
  fireEvent.drop(document.querySelector(".folder-root-drop")!, {
    dataTransfer: transfer,
  });
  fireEvent.drop(document.querySelector(".folder-root-drop")!, {
    dataTransfer: transfer,
  });
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([path]) => path.includes("/uploads")),
    ).toHaveLength(1),
  );
  mounted.rerender(view(false));
  mounted.rerender(view(true));
  resolveUpload(
    new Response(
      JSON.stringify({ items: [{ status: "duplicate", document: doc }] }),
    ),
  );
  await screen.findByText("文件已存在，已跳过", { exact: false });
  expect(
    screen.queryByRole("dialog", { name: "检测到相同内容" }),
  ).not.toBeInTheDocument();
});

it("换页缓存过期时等待新响应，旧空页不会把用户踢回首页", async () => {
  let resolveSecond: (value: Response) => void = () => {};
  const second = new Promise<Response>((resolve) => {
    resolveSecond = resolve;
  });
  const fetch = vi.fn(async (path: string) => {
    if (!path.includes("/documents")) return new Response("[]");
    if (new URL(path, "http://localhost").searchParams.get("page") === "2")
      return second;
    return new Response(
      JSON.stringify({ items: [doc], total: 51, page_size: 50 }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const qc = client();
  qc.setQueryData(["documents", kb.id, "", "", false, "date", "", "", 2], {
    items: [],
    total: 0,
    page_size: 50,
  });
  render(
    <QueryClientProvider client={qc}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  await screen.findByText(doc.display_name);
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  resolveSecond(
    new Response(
      JSON.stringify({
        items: [{ ...doc, id: "doc-2", display_name: "第二页文档.txt" }],
        total: 51,
        page_size: 50,
      }),
    ),
  );
  await screen.findByText("第二页文档.txt");
  expect(screen.getByText("2 / 2")).toBeVisible();
});

it("文档显示标签，标签筛选进入查询并在知识库切换时清除", async () => {
  const fetch = vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.includes("/documents")
            ? { items: [doc], total: 1, page_size: 50 }
            : [],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const queryClient = client();
  const view = (id = kb.id) => (
    <QueryClientProvider client={queryClient}>
      <DocumentsPane
        kb={{ ...kb, id }}
        folders={[]}
        tags={[tag]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>
  );
  const mounted = render(view());
  const user = userEvent.setup();
  await screen.findByText(doc.display_name);
  expect(document.querySelector(".document-tags")).toHaveTextContent(tag.name);
  await user.click(screen.getByRole("combobox", { name: "标签筛选" }));
  await user.click(screen.getByRole("option", { name: tag.name }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("tag_ids=tag-1"),
      expect.anything(),
    ),
  );
  mounted.rerender(view("kb-2"));
  expect(screen.getByLabelText("标签筛选")).toHaveTextContent("全部标签");
  await waitFor(() => {
    const path = fetch.mock.calls
      .map(([path]) => path)
      .reverse()
      .find((path) => path.includes("/knowledge-bases/kb-2/documents"));
    expect(path).toBeDefined();
    expect(path).not.toContain("tag_ids");
  });
});

it("关闭资料区清除标签和文档弹层，重新打开保留筛选且不恢复旧弹层", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.includes("/documents")
              ? { items: [doc], total: 1, page_size: 50 }
              : [],
          ),
        ),
    ),
  );
  const queryClient = client();
  const view = (active: boolean) => (
    <QueryClientProvider client={queryClient}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[tag]}
        trash={false}
        active={active}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>
  );
  const mounted = render(view(true));
  const user = userEvent.setup();
  await screen.findByText(doc.display_name);
  await user.click(screen.getByRole("combobox", { name: "标签筛选" }));
  await user.click(screen.getByRole("option", { name: tag.name }));
  await user.click(screen.getByRole("button", { name: "管理标签" }));
  await user.click(screen.getByRole("button", { name: "新建标签" }));
  await user.type(screen.getByLabelText("名称"), "未保存标签");
  mounted.rerender(view(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  mounted.rerender(view(true));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("标签筛选")).toHaveTextContent(tag.name);
  await user.click(screen.getByRole("button", { name: "管理标签" }));
  expect(screen.getByRole("dialog")).toHaveAccessibleName("管理标签");
  await user.click(screen.getByRole("button", { name: "新建标签" }));
  expect(screen.getByLabelText("名称")).toHaveValue("");
  mounted.rerender(view(false));
  mounted.rerender(view(true));
  await user.click(screen.getByRole("button", { name: "新建文件夹" }));
  expect(screen.getByRole("dialog")).toHaveAccessibleName("新建文件夹");
  mounted.rerender(view(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  mounted.rerender(view(true));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.contextMenu(document.querySelector(".document-row")!);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  mounted.rerender(view(false));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  mounted.rerender(view(true));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("文档内管理标签保留创建、颜色、别名、版本更新与删除", async () => {
  const fetch = vi.fn(
    async (_path: string, init?: RequestInit) =>
      new Response(init?.method === "DELETE" ? null : JSON.stringify(tag), {
        status: init?.method === "DELETE" ? 204 : 200,
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const onDelete = vi.fn();
  render(
    <QueryClientProvider client={client()}>
      <TagManager
        kbId={kb.id}
        tags={[tag]}
        open
        onOpenChange={vi.fn()}
        onDelete={onDelete}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "新建标签" }));
  await user.type(screen.getByLabelText("名称"), "新研究");
  await user.type(screen.getByLabelText("别名（英文逗号分隔）"), "new, 新知识");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("heading", { name: "管理标签" });
  expect(fetch).toHaveBeenCalledWith(
    "/api/knowledge-bases/kb-1/tags",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "新研究",
        color: "#6366f1",
        aliases: ["new", "新知识"],
      }),
    }),
  );
  await user.click(screen.getByRole("button", { name: "编辑 研究" }));
  expect(screen.getByLabelText("别名（英文逗号分隔）")).toHaveValue("Research");
  await user.clear(screen.getByLabelText("名称"));
  await user.type(screen.getByLabelText("名称"), "研究归档");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("heading", { name: "管理标签" });
  expect(fetch).toHaveBeenCalledWith(
    "/api/tags/tag-1",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        name: "研究归档",
        color: tag.color,
        aliases: tag.aliases,
        version: 4,
      }),
    }),
  );
  await user.click(screen.getByRole("button", { name: "删除 研究" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith(tag.id));
  expect(fetch).toHaveBeenCalledWith(
    "/api/tags/tag-1",
    expect.objectContaining({ method: "DELETE" }),
  );
});

it("标签版本冲突时保留编辑内容", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "version_conflict",
            message: "标签已被其他窗口更新",
          }),
          { status: 409 },
        ),
    ),
  );
  render(
    <QueryClientProvider client={client()}>
      <TagManager
        kbId={kb.id}
        tags={[tag]}
        open
        onOpenChange={vi.fn()}
        onDelete={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "编辑 研究" }));
  await user.type(screen.getByLabelText("名称"), "草稿");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
  );
  expect(screen.getByLabelText("名称")).toHaveValue("研究草稿");
});

it("完整文档页保留文件夹筛选、批量选择，并直接打开文档阅读器", async () => {
  const fetch = vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.includes("/documents")
            ? { items: [doc], total: 1, page_size: 50 }
            : [],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const onOpen = vi.fn();
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={{ ...kb, description: "阅读与研究资料" }}
        folders={[
          {
            id: "folder-1",
            kb_id: kb.id,
            name: "研究资料",
            parent_id: null,
            version: 1,
          },
        ]}
        tags={[tag]}
        trash={false}
        layout="page"
        onOpen={onOpen}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await screen.findByText(doc.display_name);
  expect(screen.getByRole("heading", { name: kb.name })).toBeInTheDocument();
  expect(screen.getByText("阅读与研究资料")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "研究资料" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("folder_id=folder-1"),
      expect.anything(),
    ),
  );
  await user.click(screen.getByRole("checkbox", { name: "全选当前页" }));
  expect(screen.getByText("已选 1 项")).toBeInTheDocument();
  await user.click(screen.getByText(doc.display_name));
  expect(onOpen).toHaveBeenCalledWith(doc, true);
});

it("侧栏文档直接阅读，成功状态隐藏，属性由菜单打开", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.includes("/documents")
              ? { items: [doc], total: 1, page_size: 50 }
              : [],
          ),
        ),
    ),
  );
  const onOpen = vi.fn();
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[tag]}
        trash={false}
        onOpen={onOpen}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText(doc.display_name));
  expect(onOpen).toHaveBeenCalledWith(doc, true);
  expect(screen.queryByText("已就绪")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: `${doc.display_name}文档菜单` }),
  );
  await user.click(screen.getByRole("menuitem", { name: "查看属性" }));
  expect(onOpen).toHaveBeenLastCalledWith(doc, false);
});

it("文档进度使用后端百分比，1以下不会放大为100%", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.includes("/documents")
              ? {
                  items: [
                    { ...doc, parse_status: "parsing", index_status: "queued" },
                  ],
                  total: 1,
                  page_size: 50,
                }
              : [
                  {
                    id: "job-progress",
                    document_id: doc.id,
                    status: "running",
                    stage: "parsing",
                    progress: 0.5,
                    attempts: 1,
                  },
                ],
          ),
        ),
    ),
  );
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[]}
        trash={false}
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("正在处理 1%")).toBeInTheDocument();
  expect(screen.queryByText("正在处理 50%")).not.toBeInTheDocument();
});

it("正文和向量已就绪时明确可检索，摘要与分类后台生成不阻止打开", async () => {
  const ready = {
    ...doc,
    summary_status: "processing",
    classification_status: "processing",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.includes("/documents")
              ? { items: [ready], total: 1, page_size: 50 }
              : [
                  {
                    id: "metadata-job",
                    document_id: doc.id,
                    status: "running",
                    stage: "enriching",
                    progress: 70,
                    attempts: 1,
                  },
                ],
          ),
        ),
    ),
  );
  const open = vi.fn();
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[]}
        trash={false}
        onOpen={open}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("可检索 · 摘要与建议生成中")).toBeVisible();
  await userEvent.click(screen.getByText(doc.display_name));
  expect(open).toHaveBeenCalledWith(ready, true);
});

it("独立回收站可恢复文档和知识库，拖入文件不会触发上传", async () => {
  const deletedKb = {
    ...kb,
    id: "kb-deleted",
    name: "旧研究库",
    deleted_at: "2026-10-22T00:00:00Z",
  };
  const fetch = vi.fn(
    async (path: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? {}
            : path.includes("/documents")
              ? { items: [doc], total: 1, page_size: 50 }
              : path.includes("include_deleted=true")
                ? [deletedKb]
                : [],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={client()}>
      <DocumentsPane
        kb={kb}
        folders={[]}
        tags={[tag]}
        trash
        layout="page"
        onOpen={vi.fn()}
        selectedId=""
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await screen.findByText(doc.display_name);
  expect(screen.getByRole("heading", { name: "回收站" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "添加知识" }),
  ).not.toBeInTheDocument();
  fireEvent.drop(screen.getByRole("region", { name: "回收站内容" }), {
    dataTransfer: {
      files: [new File(["content"], "研究.txt", { type: "text/plain" })],
      getData: vi.fn(() => ""),
    },
  });
  expect(fetch.mock.calls.some(([path]) => path.includes("/uploads"))).toBe(
    false,
  );
  fireEvent.contextMenu(document.querySelector(".document-row")!);
  const contextMenu = screen.getByRole("menu");
  expect(
    within(contextMenu).queryByRole("menuitem", { name: "重命名" }),
  ).not.toBeInTheDocument();
  await user.click(within(contextMenu).getByRole("menuitem", { name: "恢复" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/documents/doc-1/restore",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  await user.click(screen.getByText("已删除知识库 · 1"));
  await user.click(screen.getByRole("button", { name: "恢复" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/knowledge-bases/kb-deleted/restore",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});
