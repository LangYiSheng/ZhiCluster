import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DocumentsPane } from "./DocumentsPane";
import type { Folder } from "../../lib/api";

const kb = {
  id: "explorer-kb",
  name: "资料库",
  description: "工作与生活",
  version: 1,
};
const folders: Folder[] = [
  { id: "parent", kb_id: kb.id, parent_id: null, name: "项目资料", version: 1 },
  {
    id: "child",
    kb_id: kb.id,
    parent_id: "parent",
    name: "内部附件",
    version: 1,
  },
  {
    id: "sibling",
    kb_id: kb.id,
    parent_id: null,
    name: "个人阅读",
    version: 1,
  },
];
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
function mount(fetch: ReturnType<typeof vi.fn>, withFolders = true) {
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DocumentsPane
          kb={kb}
          folders={withFolders ? folders : []}
          tags={[]}
          trash={false}
          onOpen={vi.fn()}
          selectedId=""
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const emptyResponse = (path: string) =>
  new Response(
    JSON.stringify(
      path.includes("/documents") ? { items: [], total: 0, page_size: 50 } : [],
    ),
  );

it("浏览仅显示当前层文件夹，进入、后退、前进与面包屑保持目录一致", async () => {
  const fetch = vi.fn(async (path: string) => emptyResponse(path));
  mount(fetch);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "项目资料" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "内部附件" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("folder_id=root&include_descendants=false"),
      expect.anything(),
    ),
  );
  await user.click(screen.getByRole("button", { name: "项目资料" }));
  expect(screen.getByRole("button", { name: "内部附件" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "个人阅读" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("folder_id=parent&include_descendants=false"),
      expect.anything(),
    ),
  );
  expect(
    within(screen.getByRole("navigation", { name: "文件夹路径" })).getByRole(
      "button",
      { name: "项目资料" },
    ),
  ).toHaveAttribute("aria-current", "location");
  await user.click(screen.getByRole("button", { name: "后退" }));
  expect(screen.getByRole("button", { name: "个人阅读" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "前进" }));
  expect(screen.getByRole("button", { name: "内部附件" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "知识库根目录" }));
  expect(screen.getByRole("button", { name: "知识库根目录" })).toHaveAttribute(
    "aria-current",
    "location",
  );
  expect(screen.getByRole("button", { name: "个人阅读" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "内部附件" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "知识库操作" }));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["编辑知识库", "刷新文件", "管理标签"]);
});

it.each(["知识库根目录", "当前子目录"])(
  "在%s拖入文件保留对应落点，目录导入也保留相对层级",
  async (location) => {
    const submissions: {
      target: FormDataEntryValue | null;
      paths: FormDataEntryValue | null;
      filenames: string[];
    }[] = [];
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("/uploads")) {
        const body = init!.body as FormData;
        const files = body.getAll("files") as File[];
        submissions.push({
          target: body.get("folder_id"),
          paths: body.get("relative_paths"),
          filenames: files.map((file) => file.name),
        });
        return new Response(
          JSON.stringify({ items: files.map(() => ({ status: "queued" })) }),
        );
      }
      return emptyResponse(path);
    });
    mount(fetch);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "项目资料" }));
    if (location === "知识库根目录")
      await user.click(screen.getByRole("button", { name: "知识库根目录" }));
    else
      expect(
        within(
          screen.getByRole("navigation", { name: "文件夹路径" }),
        ).getByRole("button", { name: "项目资料" }),
      ).toHaveAttribute("aria-current", "location");
    fireEvent.drop(screen.getByRole("region", { name: `${kb.name}文档管理` }), {
      dataTransfer: {
        files: [new File(["直接拖入"], "资料.txt", { type: "text/plain" })],
        getData: () => "",
      },
    });
    await waitFor(() => expect(submissions).toHaveLength(1));
    const nested = new File(["嵌套原文"], "附件.txt", { type: "text/plain" });
    Object.defineProperty(nested, "webkitRelativePath", {
      value: "本地目录/子目录/附件.txt",
    });
    fireEvent.change(screen.getByLabelText("上传本地文件夹"), {
      target: { files: [nested] },
    });
    await waitFor(() => expect(submissions).toHaveLength(2));
    const target = location === "知识库根目录" ? null : "parent";
    expect(submissions).toEqual([
      { target, paths: null, filenames: ["资料.txt"] },
      {
        target,
        paths: '["本地目录/子目录/附件.txt"]',
        filenames: ["附件.txt"],
      },
    ]);
  },
);

it("搜索入口在资料工具栏，筛选仅在搜索视图且查询全库正文和文件名", async () => {
  const fetch = vi.fn(async (path: string) => emptyResponse(path));
  mount(fetch);
  const user = userEvent.setup();
  expect(
    screen.queryByRole("combobox", { name: "文件类型筛选" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "搜索知识库资料" }));
  await user.type(
    screen.getByRole("textbox", { name: "在知识库中搜索" }),
    "研究笔记",
  );
  await user.click(screen.getByRole("combobox", { name: "文件类型筛选" }));
  await user.click(screen.getByRole("option", { name: "PDF" }));
  await waitFor(() => {
    const requests = fetch.mock.calls.filter(([path]) =>
      path.includes("/documents"),
    );
    const query = new URL(requests.at(-1)![0], "http://localhost").searchParams;
    expect(query.get("q")).toBe("研究笔记");
    expect(query.get("ext")).toBe("pdf");
    expect(query.has("folder_id")).toBe(false);
  });
  await user.click(screen.getByRole("button", { name: "退出搜索" }));
  expect(
    screen.queryByRole("combobox", { name: "文件类型筛选" }),
  ).not.toBeInTheDocument();
  await waitFor(() => {
    const requests = fetch.mock.calls.filter(([path]) =>
      path.includes("/documents"),
    );
    const query = new URL(requests.at(-1)![0], "http://localhost").searchParams;
    expect(query.get("folder_id")).toBe("root");
    expect(query.has("q")).toBe(false);
    expect(query.has("ext")).toBe(false);
  });
});

it("排序菜单提供五种顺序，添加菜单只保留三项并在当前文件夹新建", async () => {
  const fetch = vi.fn(async (path: string, init?: RequestInit) =>
    path.endsWith("/folders") && init?.method === "POST"
      ? new Response(JSON.stringify({ id: "new-folder" }))
      : emptyResponse(path),
  );
  mount(fetch);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "排序文件" }));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent?.trim()),
  ).toEqual(["更新时间", "创建时间", "大小", "类型", "名称"]);
  await user.click(screen.getByRole("menuitem", { name: "大小" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("sort=size"),
      expect.anything(),
    ),
  );
  await user.click(screen.getByRole("button", { name: "项目资料" }));
  await user.click(screen.getByRole("button", { name: "添加文件" }));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent?.trim()),
  ).toEqual(["本地文件", "本地文件夹", "新建文件夹"]);
  await user.click(screen.getByRole("menuitem", { name: "新建文件夹" }));
  await user.type(screen.getByLabelText("名称"), "新附件");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    const creation = fetch.mock.calls.find(
      ([path, init]) => path.endsWith("/folders") && init?.method === "POST",
    );
    expect(creation).toBeDefined();
    expect(JSON.parse(creation![1]!.body as string)).toMatchObject({
      name: "新附件",
      parent_id: "parent",
    });
  });
});

it("本地文件夹上传发送对应相对路径，目录结构不被摊平", async () => {
  const fetch = vi.fn(async (path: string, init?: RequestInit) =>
    path.includes("/uploads") && init?.method === "POST"
      ? new Response(JSON.stringify({ items: [{ status: "queued" }] }))
      : emptyResponse(path),
  );
  mount(fetch, false);
  const directoryInput = screen.getByLabelText("上传本地文件夹");
  expect(directoryInput).toHaveAttribute("webkitdirectory");
  const file = new File(["内容"], "说明.txt", { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", {
    value: "研究资料/附件/说明.txt",
  });
  fireEvent.change(directoryInput, { target: { files: [file] } });
  await waitFor(() => {
    const upload = fetch.mock.calls.find(([path]) => path.includes("/uploads"));
    expect(upload).toBeDefined();
    const body = upload![1]!.body as FormData;
    expect(body.get("relative_paths")).toBe('["研究资料/附件/说明.txt"]');
    expect(body.getAll("files")).toHaveLength(1);
  });
});

it("超过20份目录文件自动分批，部分失败不丢已完成结果，重复副本仍对应原文件", async () => {
  const submissions: {
    names: string[];
    paths: string[];
    policy: FormDataEntryValue | null;
    target: FormDataEntryValue | null;
  }[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (!path.includes("/uploads")) return emptyResponse(path);
    const body = init!.body as FormData;
    const files = body.getAll("files") as File[];
    submissions.push({
      names: files.map((file) => file.name),
      paths: JSON.parse(body.get("relative_paths") as string),
      policy: body.get("duplicate_policy"),
      target: body.get("folder_id"),
    });
    if (files.length > 20)
      return new Response(JSON.stringify({ message: "批量数量超限" }), {
        status: 400,
      });
    if (files[0].name === "文件8.txt")
      return new Response(JSON.stringify({ message: "此文件暂时失败" }), {
        status: 503,
      });
    return new Response(
      JSON.stringify({
        items: files.map((file) => ({
          filename: file.name,
          status:
            file.name === "文件12.txt" &&
            body.get("duplicate_policy") === "skip"
              ? "duplicate"
              : "queued",
        })),
      }),
    );
  });
  mount(fetch);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "项目资料" }));
  const files = Array.from({ length: 25 }, (_, index) => {
    const file = new File([`内容${index}`], `文件${index}.txt`, {
      type: "text/plain",
    });
    Object.defineProperty(file, "webkitRelativePath", {
      value: `研究资料/附件/文件${index}.txt`,
    });
    return file;
  });
  fireEvent.change(screen.getByLabelText("上传本地文件夹"), {
    target: { files },
  });
  await screen.findByRole("dialog", { name: "检测到相同内容" });
  expect(submissions).toHaveLength(25);
  expect(
    submissions.every(
      (item) => item.names.length === 1 && item.target === "parent",
    ),
  ).toBe(true);
  expect(submissions.flatMap((item) => item.paths)).toEqual(
    files.map((file) => file.webkitRelativePath),
  );
  expect(screen.getByText("上传结果 · 25 个文件")).toBeVisible();
  expect(screen.getByText(/文件8.txt · 此文件暂时失败/)).toBeVisible();
  expect(
    within(screen.getByRole("dialog")).getByText("文件12.txt"),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "保留副本" }));
  await waitFor(() => expect(submissions).toHaveLength(26));
  expect(submissions.at(-1)).toEqual({
    names: ["文件12.txt"],
    paths: ["研究资料/附件/文件12.txt"],
    policy: "copy",
    target: "parent",
  });
});

it("目录导入进行时切换浏览目录仍使用开始时的目标，逐项结果实时可见", async () => {
  let finishSecond: (response: Response) => void = () => {};
  const second = new Promise<Response>((resolve) => {
    finishSecond = resolve;
  });
  const targets: (FormDataEntryValue | null)[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (!path.includes("/uploads")) return emptyResponse(path);
    const body = init!.body as FormData;
    targets.push(body.get("folder_id"));
    if (targets.length === 2) return second;
    return new Response(JSON.stringify({ items: [{ status: "queued" }] }));
  });
  mount(fetch);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "项目资料" }));
  const files = ["第一份.txt", "第二份.txt"].map((name) => {
    const file = new File([name], name, { type: "text/plain" });
    Object.defineProperty(file, "webkitRelativePath", {
      value: `资料/${name}`,
    });
    return file;
  });
  fireEvent.change(screen.getByLabelText("上传本地文件夹"), {
    target: { files },
  });
  await waitFor(() => expect(targets).toHaveLength(2));
  expect(screen.getByText("上传结果 · 1 个文件")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "知识库根目录" }));
  finishSecond(new Response(JSON.stringify({ items: [{ status: "queued" }] })));
  await screen.findByText("上传结果 · 2 个文件");
  expect(targets).toEqual(["parent", "parent"]);
});
