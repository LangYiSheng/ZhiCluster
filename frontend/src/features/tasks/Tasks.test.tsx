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
import { MemoryRouter } from "react-router-dom";
import { Tasks } from "./Tasks";
import type { Job } from "../../lib/api";

const kb = { id: "kb-1", name: "研究库", description: "", version: 1 };
const clients: QueryClient[] = [];
const partial: Job = {
  id: "job-partial",
  kb_id: kb.id,
  document_id: "doc-1",
  document_name: "研究.md",
  document_available: true,
  kind: "ingest",
  status: "partial_ready",
  stage: "completed",
  progress: 100,
  error: "需要配置模型服务；解析与关键词搜索已就绪",
  attempts: 1,
  created_at: "2026-10-23T00:00:00Z",
};
function renderTasks(documentId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Tasks kb={kb} documentId={documentId} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

it("部分完成的100%任务作为待处理问题显示，重试走真实任务接口", async () => {
  let retried = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      retried = true;
      return new Response(
        JSON.stringify({ ...partial, status: "queued", progress: 0 }),
      );
    }
    const jobs = [
      {
        ...partial,
        status: retried ? "queued" : "partial_ready",
        error: retried ? null : partial.error,
        progress: retried ? 0 : 100,
      },
      {
        ...partial,
        id: "done",
        document_name: "已处理.md",
        status: "completed",
        error: null,
      },
    ];
    return new Response(
      JSON.stringify(
        path.includes("group=attention")
          ? jobs.filter((job) => job.status === "partial_ready")
          : jobs,
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  renderTasks();
  expect(await screen.findByText("待配置模型")).toBeInTheDocument();
  expect(screen.getByText(partial.error!)).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.queryByText("已处理.md")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "配置模型" })).toHaveAttribute(
    "href",
    "/settings?kb=kb-1&section=models",
  );
  await userEvent.click(screen.getByRole("button", { name: "重试 研究.md" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/ingestion/jobs/job-partial/retry",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(await screen.findByText("没有需要处理的问题")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^全部/ }));
  expect(await screen.findByText("已处理.md")).toBeInTheDocument();
  expect(screen.getByText("未处理")).toBeInTheDocument();
});

it("文档任务支持真实进度、取消与可见的操作错误", async () => {
  const running = {
    ...partial,
    id: "running",
    status: "running",
    stage: "embedding",
    progress: 42.2,
    error: null,
  };
  const fetch = vi.fn(async (path: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ detail: "任务状态已变化，请刷新" }), {
          status: 409,
        })
      : new Response(
          JSON.stringify(path.includes("group=attention") ? [] : [running]),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  renderTasks("doc-1");
  await screen.findByText("没有需要处理的问题");
  await userEvent.click(screen.getByRole("button", { name: /^进行中/ }));
  expect(await screen.findByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "42",
  );
  expect(screen.getByText("正在处理 42%")).toBeInTheDocument();
  expect(screen.getByText("生成向量索引")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(
    "/api/ingestion/jobs?kb_id=kb-1&document_id=doc-1&group=active",
    expect.anything(),
  );
  expect(screen.getByRole("link", { name: "查看整个知识库" })).toHaveAttribute(
    "href",
    "/tasks?kb=kb-1",
  );
  const row = screen.getByRole("article");
  expect(
    within(row).queryByRole("button", { name: /重试/ }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(row).getByRole("button", { name: "取消 研究.md" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "任务状态已变化，请刷新",
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/ingestion/jobs/running/cancel",
    expect.objectContaining({ method: "POST" }),
  );
});
