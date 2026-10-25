import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KnowledgeBaseEditor } from "./KnowledgeBaseEditor";
import type { KnowledgeBase } from "../../lib/api";

const kb: KnowledgeBase = {
  id: "kb",
  name: "资料库",
  description: "说明",
  version: 1,
  icon: "folder",
  color: "#55a995",
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
function setup(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const saved = vi.fn();
  const change = vi.fn();
  const view = (entity: KnowledgeBase = kb, open = true) => (
    <QueryClientProvider client={client}>
      <KnowledgeBaseEditor
        open={open}
        knowledgeBase={entity}
        onOpenChange={change}
        onSaved={saved}
      />
    </QueryClientProvider>
  );
  return { ...render(view()), view, saved, change };
}
const config = {
  revision: 1,
  embedding: { model: "default-embedding", dimension: 768 },
};

it("编辑名称描述图标颜色，并用打开时版本保存以避免覆盖并发修改", async () => {
  const fetch = vi.fn(
    async (_path: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "PATCH" ? { ...kb, version: 2 } : config,
        ),
      ),
  );
  const mounted = setup(fetch);
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("名称"));
  await user.type(screen.getByLabelText("名称"), "我的新名称");
  await user.click(screen.getByRole("button", { name: "咖啡图标" }));
  fireEvent.change(screen.getByLabelText("自定义知识库颜色"), {
    target: { value: "#112233" },
  });
  mounted.rerender(mounted.view({ ...kb, name: "他人修改", version: 8 }));
  expect(screen.getByLabelText("名称")).toHaveValue("我的新名称");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(patch![1]!.body as string)).toMatchObject({
      name: "我的新名称",
      description: "说明",
      icon: "coffee",
      color: "#112233",
      version: 1,
      embedding_model: null,
      embedding_dimension: null,
    });
  });
});

it("嵌入模型只能单选且自定义模型必须显式填写维度", async () => {
  const fetch = vi.fn(
    async (_path: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "PATCH" ? { ...kb, version: 2 } : config,
        ),
      ),
  );
  setup(fetch);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "手动填写" }));
  await user.type(
    screen.getByRole("textbox", { name: "知识库嵌入模型" }),
    "my-embedding",
  );
  expect(screen.getByLabelText("向量维度")).toHaveValue(null);
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(
    false,
  );
  await user.type(screen.getByLabelText("向量维度"), "1536");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(patch![1]!.body as string)).toMatchObject({
      embedding_model: "my-embedding",
      embedding_dimension: 1536,
    });
  });
});

it("关闭重开后旧模型列表失败不会污染新草稿", async () => {
  let resolveCatalog: (response: Response) => void = () => {};
  const catalog = new Promise<Response>((resolve) => {
    resolveCatalog = resolve;
  });
  const fetch = vi.fn(async (path: string) =>
    path.endsWith("/models") ? catalog : new Response(JSON.stringify(config)),
  );
  const mounted = setup(fetch);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "获取可用模型" }));
  mounted.rerender(mounted.view(kb, false));
  mounted.rerender(mounted.view(kb));
  resolveCatalog(
    new Response(JSON.stringify({ message: "旧请求失败" }), { status: 500 }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "获取可用模型" }),
    ).not.toBeDisabled(),
  );
  expect(screen.queryByText(/旧请求失败/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "知识库嵌入模型" }),
  ).toBeVisible();
});
