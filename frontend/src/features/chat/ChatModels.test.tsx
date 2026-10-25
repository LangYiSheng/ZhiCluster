import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render as renderUI,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Chat } from "./Chat";
const render = (element: ReactElement) =>
  renderUI(element, { wrapper: MemoryRouter });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const kb = { id: "kb-a", name: "研究库", version: 1, description: "" };
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value));
function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

it("选择模型和思考模式进入真实发送参数，模型偏好按知识库保存", async () => {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let created = false;
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
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push({ path, body });
        if (path === "/api/conversations") {
          created = true;
          return jsonResponse({
            id: "c-a",
            title: "问题",
            kb_id: kb.id,
            scope: body.scope,
          });
        }
        return jsonResponse({
          id: "m-a",
          role: "assistant",
          content: "",
          status: "queued",
        });
      }
      if (path.endsWith("/settings/chat-models"))
        return jsonResponse({
          models: ["model-a", "model-b"],
          default_model: "model-a",
          supports_tools: true,
        });
      if (path.includes("/conversations?"))
        return jsonResponse(
          created
            ? [{ id: "c-a", kb_id: kb.id, scope: { kb_ids: [kb.id] } }]
            : [],
        );
      return jsonResponse([]);
    }),
  );
  render(
    <QueryClientProvider client={client()}>
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
  const trigger = screen.getByRole("button", { name: "选择模型与思考模式" });
  await vi.waitFor(() => expect(trigger).toHaveTextContent("model-a"));
  expect(trigger).toHaveTextContent("快速");
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "model-b" }));
  expect(trigger).toHaveTextContent("model-b");
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "思考" }));
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await user.type(
    screen.getByRole("textbox", { name: "知识库问题" }),
    "分析资料",
  );
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  await vi.waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[0].body.kb_id).toBe(kb.id);
  expect(posts[1].body).toEqual({
    content: "分析资料",
    model: "model-b",
    retrieval_mode: "model",
  });
  expect(localStorage.getItem(`zhicluster:chat-model:${kb.id}`)).toBe(
    "model-b",
  );
});

it("新知识库历史为空，过期本地指针及其他库历史都不会加载消息", async () => {
  localStorage.setItem(`conversation:${kb.id}`, "foreign");
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      if (path.endsWith("/settings/chat-models"))
        return jsonResponse({
          models: [],
          default_model: "",
          supports_tools: false,
        });
      if (path.includes("/conversations?"))
        return jsonResponse([
          {
            id: "foreign",
            title: "其他库的对话",
            kb_id: "kb-b",
            scope: { kb_ids: ["kb-b", kb.id] },
          },
        ]);
      return jsonResponse([]);
    }),
  );
  render(
    <QueryClientProvider client={client()}>
      <Chat
        kb={kb}
        knowledgeBases={[kb]}
        folders={[]}
        tags={[]}
        onCitation={vi.fn()}
        historyOpen
      />
    </QueryClientProvider>,
  );
  await screen.findByText("还没有历史对话");
  expect(screen.queryByText("其他库的对话")).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(localStorage.getItem(`conversation:${kb.id}`)).toBe(""),
  );
  expect(paths).toContain("/api/conversations?kb_id=kb-a");
  expect(paths.some((path) => path.includes("/foreign/"))).toBe(false);
});

it("模型目录尚未返回时阻止发送，返回后恢复知识库首选模型", async () => {
  localStorage.setItem(`zhicluster:chat-model:${kb.id}`, "model-b");
  let resolveCatalog!: (response: Response) => void;
  const pendingCatalog = new Promise<Response>((resolve) => {
    resolveCatalog = resolve;
  });
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(path);
      if (path.endsWith("/settings/chat-models")) return pendingCatalog;
      return jsonResponse([]);
    }),
  );
  render(
    <QueryClientProvider client={client()}>
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
    screen.getByRole("textbox", { name: "知识库问题" }),
    "等待首选模型{Enter}",
  );
  expect(screen.getByRole("button", { name: "发送问题" })).toBeDisabled();
  expect(posts).toEqual([]);
  await act(async () =>
    resolveCatalog(
      jsonResponse({
        models: ["model-a", "model-b"],
        default_model: "model-a",
        supports_tools: false,
      }),
    ),
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "发送问题" })).toBeEnabled(),
  );
  expect(
    screen.getByRole("button", { name: "选择模型与思考模式" }),
  ).toHaveTextContent("model-b");
});

it("新会话消息提交期间切走，返回后仍恢复原会话且保留失败重试入口", async () => {
  let resolveMessage!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveMessage = resolve; });
  let created = false;
  const paths: string[] = [];
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    paths.push(path);
    if (path.endsWith("/settings/chat-models")) return jsonResponse({ models: [], default_model: "", supports_tools: false });
    if (init?.method === "POST" && path === "/api/conversations") {
      created = true;
      return jsonResponse({ id: "pending-conversation", kb_id: kb.id, scope: { kb_ids: [kb.id] } });
    }
    if (init?.method === "POST") return pending;
    if (path.includes("/conversations?")) return jsonResponse(created ? [{ id: "pending-conversation", kb_id: kb.id, scope: { kb_ids: [kb.id] } }] : []);
    return jsonResponse([]);
  }));
  const queryClient = client();
  const view = () => <QueryClientProvider client={queryClient}><Chat kb={kb} knowledgeBases={[kb]} folders={[]} tags={[]} onCitation={vi.fn()} /></QueryClientProvider>;
  const mounted = render(view());
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "知识库问题" }), "不会丢失的提交");
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "发送问题" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  await vi.waitFor(() => expect(localStorage.getItem(`conversation:${kb.id}`)).toBe("pending-conversation"));
  mounted.unmount();
  await act(async () => resolveMessage(jsonResponse({ id: "m-pending", role: "assistant", status: "queued", content: "" })));
  render(view());
  await vi.waitFor(() => expect(paths).toContain("/api/conversations/pending-conversation/messages"));
  expect(localStorage.getItem(`conversation:${kb.id}`)).toBe("pending-conversation");
  expect(paths.filter(path => path === "/api/conversations")).toHaveLength(1);
});
