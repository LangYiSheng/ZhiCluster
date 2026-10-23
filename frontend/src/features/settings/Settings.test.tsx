import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Settings } from "./Settings";
import type { RuntimeConfig } from "../../lib/settings";
import { DEFAULT_APPEARANCE } from "../../lib/appearance";
import { useUI } from "../../stores/ui";

const initial: RuntimeConfig = {
  revision: 7,
  llm: {
    base_url: "https://chat.example/v1",
    model: "chat-old",
    api_key_configured: true,
    timeout_seconds: 60,
    max_retries: 2,
    supports_tools: true,
  },
  embedding: {
    base_url: "https://vector.example/v1",
    model: "vector-old",
    api_key_configured: true,
    timeout_seconds: 60,
    max_retries: 2,
    dimension: 1024,
    batch_size: 32,
  },
  processing: {
    chunk_size_tokens: 1024,
    chunk_overlap_tokens: 128,
    max_ingestion_attempts: 3,
    max_concurrent_model_calls: 2,
    summary_input_tokens: 16000,
    summary_max_calls: 10,
  },
};
type Request = { path: string; method: string; body: Record<string, unknown> };
let requests: Request[];
let server: RuntimeConfig;
let conflict = false;
let pendingProbe: ((response: Response) => void) | undefined;
let deferProbe = false;
let deferSave = false;
let pendingSave: ((response: Response) => void) | undefined;
const routers: ReturnType<typeof createMemoryRouter>[] = [];
function setup(initialPath = "/settings") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/settings", element: <Settings kbId="kb-1" /> },
      { path: "/chat", element: <p>已返回知识对话</p> },
    ],
    { initialEntries: [initialPath] },
  );
  routers.push(router);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), router };
}
async function models(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "外观与布局" });
  await user.click(screen.getByRole("button", { name: "模型连接" }));
  await user.click(chatFields().getByRole("button", { name: "手动填写" }));
}
function chatFields() {
  return within(screen.getByRole("region", { name: "聊天模型" }));
}
beforeEach(() => {
  requests = [];
  server = structuredClone(initial);
  conflict = false;
  pendingProbe = undefined;
  deferProbe = false;
  deferSave = false;
  pendingSave = undefined;
  localStorage.clear();
  sessionStorage.clear();
  useUI.setState(DEFAULT_APPEARANCE);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method || "GET",
        body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ path, method, body });
      if (path.endsWith("/settings/config")) {
        if (method === "PUT") {
          if (deferSave)
            return new Promise<Response>((resolve) => {
              pendingSave = resolve;
            });
          if (conflict)
            return new Response(
              JSON.stringify({
                error: {
                  code: "revision_conflict",
                  message: "changed elsewhere",
                },
              }),
              { status: 409 },
            );
          for (const group of ["llm", "embedding", "processing"] as const) {
            const incoming = body[group] as Record<string, unknown>;
            const merged = { ...server[group], ...incoming };
            if ("api_key" in merged) delete merged.api_key;
            if ("clear_api_key" in merged) delete merged.clear_api_key;
            server = { ...server, [group]: merged };
          }
          server.revision++;
        }
        return new Response(JSON.stringify(server));
      }
      if (path.endsWith("/settings/model-status"))
        return new Response(
          JSON.stringify({
            embedding: { configured: true },
            llm: { configured: true },
          }),
        );
      if (path.endsWith("/knowledge-bases"))
        return new Response(
          JSON.stringify([
            { id: "kb-1", name: "研究笔记" },
            { id: "kb-2", name: "另一知识库" },
          ]),
        );
      if (path.endsWith("/settings/test-models")) {
        if (deferProbe)
          return new Promise<Response>((resolve) => {
            pendingProbe = resolve;
          });
        return new Response(
          JSON.stringify({
            [String(body.scope)]: {
              ok: true,
              message: "服务可连接",
              elapsed_ms: 12,
            },
          }),
        );
      }
      if (path.endsWith("/settings/models"))
        return new Response(
          JSON.stringify({
            models: [
              { id: body.scope === "llm" ? "chat-catalog" : "vector-catalog" },
            ],
          }),
        );
      return new Response(JSON.stringify({ status: "queued" }));
    }),
  );
});
afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  vi.unstubAllGlobals();
});

describe("网页设置草稿", () => {
  it("只在模型连接分类自动拉目录，分别选择模型保留草稿且不重新拉取", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { name: "外观与布局" });
    expect(
      requests.some((request) => request.path.endsWith("/settings/models")),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "模型连接" }));
    await waitFor(
      () =>
        expect(
          requests.filter((request) =>
            request.path.endsWith("/settings/models"),
          ),
        ).toHaveLength(2),
      { timeout: 2000 },
    );
    await user.click(chatFields().getByRole("combobox", { name: "模型名称" }));
    await user.click(screen.getByRole("option", { name: "chat-catalog" }));
    expect(
      chatFields().getByRole("combobox", { name: "模型名称" }),
    ).toHaveTextContent("chat-catalog");
    expect(
      within(screen.getByRole("region", { name: "向量模型" })).getByRole(
        "combobox",
        { name: "模型名称" },
      ),
    ).toHaveTextContent("vector-old");
    await user.click(screen.getByRole("button", { name: "知识处理" }));
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(
      requests.filter((request) => request.path.endsWith("/settings/models")),
    ).toHaveLength(2);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(
      0,
    );
    await user.click(screen.getByRole("button", { name: "模型连接" }));
    expect(
      chatFields().getByRole("combobox", { name: "模型名称" }),
    ).toHaveTextContent("chat-catalog");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeEnabled();
  });
  it("任务列表可直接定位模型连接，站内跳转定位保留已有草稿", async () => {
    const { user, router } = setup("/settings?section=models");
    await screen.findByRole("heading", { name: "模型连接" });
    await user.click(chatFields().getByRole("button", { name: "手动填写" }));
    await user.type(chatFields().getByLabelText("模型名称"), "-draft");
    await user.click(screen.getByRole("button", { name: "外观与布局" }));
    await act(async () => {
      await router.navigate("/settings?section=models");
    });
    expect(chatFields().getByLabelText("模型名称")).toHaveValue(
      "chat-old-draft",
    );
  });
  it("配色卡片保留键盘单选操作，选择后需要保存", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { name: "外观与布局" });
    const ink = screen.getByRole("radio", { name: /暖白墨黑/ });
    const sage = screen.getByRole("radio", { name: /鼠尾草绿/ });
    expect(ink).toBeChecked();
    ink.focus();
    await user.keyboard("{ArrowRight}");
    expect(sage).toBeChecked();
    expect(sage).toHaveFocus();
    expect(sage.closest("label")).toHaveClass("is-selected");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeEnabled();
  });
  it("切换分类保留草稿，保存时携带revision并省略留空的已存密钥", async () => {
    const { user } = setup();
    await models(user);
    expect(chatFields().getByLabelText("API 密钥")).toHaveValue("");
    await user.clear(chatFields().getByLabelText("模型名称"));
    await user.type(chatFields().getByLabelText("模型名称"), "chat-new");
    await user.click(screen.getByRole("button", { name: "知识处理" }));
    expect(screen.getByText("有未保存的修改")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "模型连接" }));
    expect(chatFields().getByLabelText("模型名称")).toHaveValue("chat-new");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText(/设置已保存/);
    const request = requests.find((item) => item.method === "PUT")!;
    expect(request.body.revision).toBe(7);
    expect(request.body.llm).toMatchObject({ model: "chat-new" });
    expect(request.body.llm).not.toHaveProperty("api_key");
    expect(request.body.llm).not.toHaveProperty("api_key_configured");
    expect(request.body.embedding).not.toHaveProperty("api_key");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
  });
  it("新密钥仅在请求中发送，保存后清空；明确勾选才发送清除标记", async () => {
    const { user } = setup();
    await models(user);
    await user.type(
      chatFields().getByLabelText("API 密钥"),
      "typed-secret-example",
    );
    expect(JSON.stringify(localStorage)).not.toContain("typed-secret-example");
    expect(JSON.stringify(sessionStorage)).not.toContain(
      "typed-secret-example",
    );
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText(/设置已保存/);
    expect(
      requests.find((item) => item.method === "PUT")!.body.llm,
    ).toMatchObject({ api_key: "typed-secret-example" });
    expect(chatFields().getByLabelText("API 密钥")).toHaveValue("");
    await user.click(chatFields().getByLabelText("保存时清除现有密钥"));
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(requests.filter((item) => item.method === "PUT")).toHaveLength(2),
    );
    expect(
      requests.filter((item) => item.method === "PUT")[1].body.llm,
    ).toMatchObject({ clear_api_key: true });
    expect(
      requests.filter((item) => item.method === "PUT")[1].body.llm,
    ).not.toHaveProperty("api_key");
  });
  it("冲突保留草稿，重新读取需明确放弃并使用最新revision", async () => {
    const { user } = setup();
    await models(user);
    await user.type(chatFields().getByLabelText("模型名称"), "-draft");
    conflict = true;
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText(/设置已在其他窗口更新/);
    expect(chatFields().getByLabelText("模型名称")).toHaveValue(
      "chat-old-draft",
    );
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    server = {
      ...server,
      revision: 8,
      llm: { ...server.llm, model: "chat-remote" },
    };
    await user.click(screen.getByRole("button", { name: "重新读取最新设置" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("放弃尚未保存");
    await user.click(
      screen.getByRole("button", { name: "放弃草稿并重新读取" }),
    );
    await waitFor(() =>
      expect(chatFields().getByLabelText("模型名称")).toHaveValue(
        "chat-remote",
      ),
    );
    conflict = false;
    await user.type(chatFields().getByLabelText("模型名称"), "-new");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(requests.filter((item) => item.method === "PUT")).toHaveLength(2),
    );
    expect(
      requests.filter((item) => item.method === "PUT")[1].body.revision,
    ).toBe(8);
  });
  it("连接测试只发所选scope的草稿，不保存且分开显示测试结果", async () => {
    const { user } = setup();
    await models(user);
    await user.clear(chatFields().getByLabelText("模型名称"));
    await user.type(chatFields().getByLabelText("模型名称"), "unsaved-chat");
    await user.type(
      chatFields().getByLabelText("API 密钥"),
      "draft-only-secret",
    );
    await user.click(screen.getByRole("button", { name: "测试聊天连接" }));
    await screen.findByText("测试通过");
    const request = requests.find((item) =>
      item.path.endsWith("/test-models"),
    )!;
    expect(request.body).toMatchObject({
      scope: "llm",
      draft: { llm: { model: "unsaved-chat", api_key: "draft-only-secret" } },
    });
    expect(request.body.draft).not.toHaveProperty("embedding");
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
    expect(screen.getByText("有未保存的修改")).toBeVisible();
    await user.type(chatFields().getByLabelText("模型名称"), "-changed");
    expect(screen.getByText(/此结果对应先前的草稿/)).toBeVisible();
  });
  it("一个scope测试时，其他scope仍可操作，结果不会覆盖各自状态", async () => {
    const { user } = setup();
    await models(user);
    deferProbe = true;
    await user.click(screen.getByRole("button", { name: "测试聊天连接" }));
    expect(screen.getByRole("button", { name: "正在测试…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试工具调用" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "向量模型" })).toBeVisible();
    expect(screen.getByRole("button", { name: "测试向量连接" })).toBeEnabled();
    await act(async () =>
      pendingProbe?.(
        new Response(
          JSON.stringify({ llm: { ok: true, message: "聊天测试完成" } }),
        ),
      ),
    );

    expect(await screen.findByText("聊天测试完成")).toBeVisible();
  });
  it("跨字段校验失败时定位到错误字段，并阻止保存", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { name: "外观与布局" });
    await user.click(screen.getByRole("button", { name: "知识处理" }));
    await user.clear(screen.getByLabelText("切块重叠（Token）"));
    await user.type(screen.getByLabelText("切块重叠（Token）"), "1024");
    await user.click(screen.getByRole("button", { name: "模型连接" }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByText("重叠长度必须小于切块长度。")).toBeVisible();
    expect(screen.getByLabelText("切块重叠（Token）")).toHaveFocus();
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
  });
  it("同屏模型卡片独立编辑，校验能展开对应高级选项", async () => {
    const { user } = setup();
    await models(user);
    const embedding = within(screen.getByRole("region", { name: "向量模型" }));
    await user.click(embedding.getByText("高级连接选项"));
    await user.clear(embedding.getByLabelText("请求超时（秒）"));
    await user.type(embedding.getByLabelText("请求超时（秒）"), "700");
    await user.click(embedding.getByText("高级连接选项"));
    await user.click(screen.getByRole("button", { name: "知识处理" }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    const timeout = await screen.findByDisplayValue("700");
    expect(timeout).toHaveFocus();
    expect(timeout.closest("details")).toHaveAttribute("open");
    expect(chatFields().getByLabelText("模型名称")).toHaveValue("chat-old");
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
  });
  it("离开有草稿时确认，可继续编辑或明确放弃", async () => {
    const { user, router } = setup();
    await models(user);
    await user.type(
      chatFields().getByLabelText("API 密钥"),
      "leave-draft-secret",
    );
    await act(async () => {
      await router.navigate("/chat");
    });
    expect(screen.getByRole("dialog")).toHaveTextContent("离开设置会丢失草稿");
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(chatFields().getByLabelText("API 密钥")).toHaveValue(
      "leave-draft-secret",
    );
    await act(async () => {
      await router.navigate("/chat");
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    });
    expect(await screen.findByText("已返回知识对话")).toBeVisible();
    expect(JSON.stringify(localStorage)).not.toContain("leave-draft-secret");
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
  });
  it("重建明确指定库并确认模型费用后提交", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { name: "外观与布局" });
    await user.click(screen.getByRole("button", { name: "索引维护" }));
    await user.click(screen.getByRole("combobox", { name: "要维护的知识库" }));
    await user.click(screen.getByRole("option", { name: "另一知识库" }));
    await user.click(
      screen.getByRole("button", { name: "重建所选知识库向量索引" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("另一知识库");
    expect(screen.getByRole("dialog")).toHaveTextContent("模型费用");
    expect(
      requests.some((item) => item.path.endsWith("rebuild-embeddings")),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "确认费用并重建" }));
    await screen.findByText(/重建任务已加入队列/);
    expect(
      requests.find((item) => item.path.endsWith("rebuild-embeddings"))?.body,
    ).toEqual({ kb_id: "kb-2" });
  });
  it("撤销新密钥和清除选择后恢复干净状态", async () => {
    const { user } = setup();
    await models(user);
    await user.type(
      chatFields().getByLabelText("API 密钥"),
      "temporary-secret",
    );
    await user.clear(chatFields().getByLabelText("API 密钥"));
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    await user.click(chatFields().getByLabelText("保存时清除现有密钥"));
    expect(screen.getByRole("button", { name: "保存修改" })).toBeEnabled();
    await user.click(chatFields().getByLabelText("保存时清除现有密钥"));
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
  });
  it("保存期间锁住字段，保存完成后显示服务器结果", async () => {
    const { user } = setup();
    await models(user);
    await user.type(chatFields().getByLabelText("模型名称"), "-saved");
    deferSave = true;
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(chatFields().getByLabelText("模型名称")).toBeDisabled();
    expect(chatFields().getByLabelText("API 密钥")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    await act(async () =>
      pendingSave?.(
        new Response(
          JSON.stringify({
            ...server,
            revision: 8,
            llm: { ...server.llm, model: "chat-old-saved" },
          }),
        ),
      ),
    );
    expect(await screen.findByText(/设置已保存/)).toBeVisible();
    expect(chatFields().getByLabelText("模型名称")).toBeEnabled();
    expect(chatFields().getByLabelText("模型名称")).toHaveValue(
      "chat-old-saved",
    );
  });
  it("外观单独保存到当前浏览器，无须写入模型配置", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { name: "外观与布局" });
    await user.click(screen.getByRole("combobox", { name: "显示模式" }));
    await user.click(screen.getByRole("option", { name: "深色" }));
    expect(useUI.getState().theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText(/设置已保存/);
    expect(useUI.getState().theme).toBe("dark");
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
  });
});
