import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { MemoryRouter } from "react-router-dom";
import type { Citation, Document } from "../lib/api";
import { App } from "./App";
import { useUI } from "../stores/ui";

const fixtures = vi.hoisted(() => {
  const document = (id: string, name: string) => ({
    id,
    display_name: name,
    kb_id: "kb-1",
    folder_id: null,
    original_filename: name,
    ext: "md",
    size_bytes: 30,
    version: 1,
    parse_status: "ready",
    index_status: "ready",
    summary_status: "ready",
    classification_status: "ready",
    created_at: "2026-10-24T00:00:00Z",
  });
  return { a: document("doc-a", "来源A.md"), b: document("doc-b", "来源B.md") };
});

// Keep the actual App, reference reducer, ReferencePane, router and API client.
// Only child feature internals are replaced by controls that use their public callbacks.
vi.mock("../features/chat/Chat", () => ({
  Chat: ({ onCitation }: { onCitation: (citation: Citation) => void }) => (
    <div>
      <button
        onClick={() =>
          onCitation({ document_id: "doc-a", chunk_id: "chunk-a" })
        }
      >
        查看来源A
      </button>
      <button
        onClick={() =>
          onCitation({ document_id: "doc-b", chunk_id: "chunk-b" })
        }
      >
        查看来源B
      </button>
    </div>
  ),
}));
vi.mock("../features/documents/DocumentsPane", () => ({
  DocumentsPane: ({
    onOpen,
  }: {
    onOpen: (document: Document, reader?: boolean) => void;
  }) => (
    <div>
      <p>资料管理测试内容</p>
      <button onClick={() => onOpen(fixtures.b, true)}>
        在资料管理中打开B
      </button>
    </div>
  ),
}));
vi.mock("../features/documents/Reader", () => ({
  Reader: ({ documentId }: { documentId: string }) => (
    <p>阅读文档 {documentId}</p>
  ),
}));
vi.mock("../features/kb/Library", () => ({ Library: () => <p>知识库列表</p> }));
vi.mock("../features/search/SearchDialog", () => ({
  SearchDialog: () => null,
}));

type PendingDocument = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};
let documents: Map<string, PendingDocument>;
let client: QueryClient;
function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  render(
    <MemoryRouter initialEntries={["/chat?kb=kb-1"]}>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return screen.findByRole("button", { name: "查看来源A" });
}
async function deliver(id: "a" | "b") {
  const pending = documents.get(fixtures[id].id);
  expect(pending).toBeDefined();
  await act(async () => {
    pending!.resolve(response(fixtures[id]));
    await pending!.promise;
  });
}

beforeEach(() => {
  documents = new Map();
  localStorage.clear();
  sessionStorage.clear();
  useUI.setState({ sidebarOpen: true });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      if (path === "/api/knowledge-bases")
        return Promise.resolve(
          response([
            { id: "kb-1", name: "隔离测试库", version: 1, description: "" },
          ]),
        );
      if (path.startsWith("/api/knowledge-bases/kb-1/"))
        return Promise.resolve(response([]));
      if (path.startsWith("/api/documents/")) {
        let resolve!: (response: Response) => void;
        const promise = new Promise<Response>((done) => {
          resolve = done;
        });
        documents.set(path.slice("/api/documents/".length), {
          promise,
          resolve,
        });
        return promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it("来源A等待GET时打开资料管理，A迟到不会抢占资料管理", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "查看来源A" }));
  await waitFor(() => expect(documents.has("doc-a")).toBe(true));
  await user.click(screen.getByRole("button", { name: "浏览资料" }));
  expect(await screen.findByText("资料管理测试内容")).toBeVisible();
  await deliver("a");
  const pane = screen.getByRole("complementary", { name: "参考资料" });
  expect(
    within(pane).getByRole("tabpanel", { name: "资料管理" }),
  ).toBeVisible();
  expect(screen.queryByText("阅读文档 doc-a")).not.toBeInTheDocument();
});

it("来源A等待GET时收起侧栏，A迟到不会重新展开", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "浏览资料" }));
  await user.click(screen.getByRole("button", { name: "查看来源A" }));
  await waitFor(() => expect(documents.has("doc-a")).toBe(true));
  await user.click(screen.getByRole("button", { name: "收起资料侧栏" }));
  await deliver("a");
  expect(screen.getByRole("button", { name: "展开资料侧栏" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    screen.queryByRole("complementary", { name: "参考资料" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("阅读文档 doc-a")).not.toBeInTheDocument();
});

it("来源B先返回并打开后，较早的来源A迟到不会覆盖B", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "查看来源A" }));
  await user.click(screen.getByRole("button", { name: "查看来源B" }));
  await waitFor(() =>
    expect(documents.has("doc-a") && documents.has("doc-b")).toBe(true),
  );
  await deliver("b");
  expect(await screen.findByText("阅读文档 doc-b")).toBeVisible();
  await deliver("a");
  expect(screen.getByText("阅读文档 doc-b")).toBeVisible();
  expect(screen.queryByText("阅读文档 doc-a")).not.toBeInTheDocument();
});

it("来源A等待GET时从资料管理直接打开B，A迟到不会抢占B", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "浏览资料" }));
  await user.click(screen.getByRole("button", { name: "查看来源A" }));
  await waitFor(() => expect(documents.has("doc-a")).toBe(true));
  await user.click(screen.getByRole("button", { name: "在资料管理中打开B" }));
  expect(await screen.findByText("阅读文档 doc-b")).toBeVisible();
  await deliver("a");
  expect(screen.getByText("阅读文档 doc-b")).toBeVisible();
  expect(screen.queryByText("阅读文档 doc-a")).not.toBeInTheDocument();
});

it("打开引用文档后关闭资料侧栏，焦点返回侧栏展开按钮", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "查看来源B" }));
  await waitFor(() => expect(documents.has("doc-b")).toBe(true));
  await deliver("b");
  expect(await screen.findByText("阅读文档 doc-b")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "关闭参考资料" }));
  expect(screen.getByRole("button", { name: "展开资料侧栏" })).toHaveFocus();
  expect(
    screen.queryByRole("complementary", { name: "参考资料" }),
  ).not.toBeInTheDocument();
});

it("关闭当前文档标签只剩资料管理时，焦点落到仍可见的侧栏关闭按钮", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "浏览资料" }));
  await user.click(screen.getByRole("button", { name: "在资料管理中打开B" }));
  expect(await screen.findByText("阅读文档 doc-b")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "关闭 来源B.md" }));
  expect(screen.getByRole("button", { name: "关闭参考资料" })).toHaveFocus();
  expect(screen.getByRole("tabpanel", { name: "资料管理" })).toBeVisible();
  expect(screen.queryByText("阅读文档 doc-b")).not.toBeInTheDocument();
});

it("左栏收起后图标导航仍可切换页面，并保持收起状态", async () => {
  const user = userEvent.setup();
  await mount();
  await user.click(screen.getByRole("button", { name: "折叠知识库栏" }));
  const rail = screen.getByRole("navigation", { name: "折叠导航" });
  expect(rail).not.toHaveAttribute("inert");
  expect(
    screen.getByRole("complementary", { name: "知识库与主导航" }),
  ).toHaveAttribute("inert");
  await user.click(within(rail).getByRole("button", { name: "文档管理" }));
  expect(
    await within(screen.getByRole("main")).findByText("文档管理", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    within(rail).getByRole("button", { name: "文档管理" }),
  ).toHaveAttribute("aria-current", "page");
  expect(useUI.getState().sidebarOpen).toBe(false);
});

it("右栏只在浏览资料旁保留开关，重新展开恢复此前文档", async () => {
  const user = userEvent.setup();
  await mount();
  const browse = screen.getByRole("button", { name: "浏览资料" });
  const toggle = screen.getByRole("button", { name: "展开资料侧栏" });
  expect(toggle.parentElement).toBe(browse.parentElement);
  expect(
    screen.queryByRole("navigation", { name: "资料侧栏快捷操作" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "查看来源B" }));
  await waitFor(() => expect(documents.has("doc-b")).toBe(true));
  await deliver("b");
  expect(await screen.findByText("阅读文档 doc-b")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "收起资料侧栏" }));
  await user.click(screen.getByRole("button", { name: "展开资料侧栏" }));
  expect(screen.getByRole("tabpanel", { name: "来源B.md" })).toBeVisible();
  expect(screen.getByText("阅读文档 doc-b")).toBeVisible();
});
