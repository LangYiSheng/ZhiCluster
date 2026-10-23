import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Operation } from "../../lib/api";
import type { ReviewRun, ReviewSuggestion } from "./api";
import { Suggestions } from "./Suggestions";
import { PlanEditor } from "./PlanEditor";
import { CreatePlan } from "./CreatePlan";
import { Review } from "./Review";

const clients: QueryClient[] = [];
function mount(view: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{view}</QueryClientProvider>
    </MemoryRouter>,
  );
}
const kb = { id: "kb-1", name: "研究库", version: 1, description: "" };
const first: ReviewSuggestion = {
  id: "s-1",
  suggestion_id: "s-1",
  document_id: "doc-1",
  document_name: "研究方法.pdf",
  kb_id: kb.id,
  kb_name: kb.name,
  status: "pending",
  document_version: 1,
  current_version: 1,
  conflict: false,
  can_edit: true,
  document_available: true,
  current_folder_path: "未分类",
  target_folder_path: "研究 / 方法",
  existing_tag_names: ["研究"],
  payload: {
    existing_folder_id: "f-new",
    proposed_folder_path: null,
    existing_tag_ids: ["tag-1"],
    new_tag_names: [],
    reason: "内容与研究方法相关",
  },
};
const second: ReviewSuggestion = {
  ...first,
  id: "s-2",
  suggestion_id: "s-2",
  document_id: "doc-2",
  document_name: "旧建议.txt",
  current_version: 2,
  conflict: true,
};
const page = (items = [first, second]) => ({
  items,
  total: items.length,
  page: 1,
  page_size: 30,
  counts: { pending: items.length, applied: 0, rejected: 0 },
});
const folders = [
  { id: "f-root", name: "研究", kb_id: kb.id, parent_id: null, version: 1 },
  { id: "f-new", name: "方法", kb_id: kb.id, parent_id: "f-root", version: 1 },
];
const planRun: ReviewRun = {
  id: "run-1",
  kb_id: kb.id,
  goal: "按主题整理",
  status: "pending_review",
  events: [],
  plan: {
    id: "plan-1",
    version: 1,
    status: "pending_review",
    payload: {
      summary: "移动资料并更新名称",
      expected_changes: 1,
      risk_level: "low",
      base_versions: { "document:doc-1": 1 },
      operations: [
        {
          operation_id: "move-1",
          type: "move_documents",
          description: "移动研究方法",
          target_ids: ["doc-1"],
          params: { folder_id: "f-new" },
          dependencies: [],
          enabled: true,
        },
        {
          operation_id: "rename-1",
          type: "rename_document",
          description: "更新文档名称",
          target_ids: ["doc-1"],
          params: { name: "原建议名称" },
          dependencies: [],
          enabled: true,
        },
      ],
    },
    preview: [
      {
        operation_id: "move-1",
        targets: [
          {
            id: "doc-1",
            name: "研究方法.pdf",
            kind: "document",
            folder_path: "原目录",
            available: true,
          },
        ],
        destination_path: "研究 / 方法",
      },
      {
        operation_id: "rename-1",
        targets: [
          {
            id: "doc-1",
            name: "研究方法.pdf",
            kind: "document",
            folder_path: "原目录",
            available: true,
          },
        ],
      },
    ],
  },
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it("分类建议先预览移动位置，批量应用按旧版本提交并逐项显示成功与冲突", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        return response({
          items: [
            { suggestion_id: "s-1", status: "applied", run_id: "applied-1" },
            {
              suggestion_id: "s-2",
              status: "conflict",
              message: "文档版本有更新，请重新生成建议",
            },
          ],
          succeeded: 1,
          failed: 1,
        });
      }
      return response(page());
    }),
  );
  const showPlan = vi.fn();
  mount(<Suggestions kbId="" onShowPlan={showPlan} />);
  await screen.findByText(first.document_name);
  expect(
    screen.getByRole("link", { name: `查看原文：${first.document_name}` }),
  ).toHaveAttribute("href", "/document?kb=kb-1&document=doc-1&mode=read");
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "选择本页建议" }));
  await user.click(screen.getByRole("button", { name: "应用所选" }));
  const dialog = screen.getByRole("dialog", { name: "应用 2 条分类建议" });
  expect(within(dialog).getAllByText(/研究 \/ 方法/)).toHaveLength(2);
  expect(requests).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "确认应用" }));
  const results = await screen.findByRole("region", { name: "逐项处理结果" });
  expect(within(results).getByText("已应用")).toBeVisible();
  expect(
    within(results).getByText("文档版本有更新，请重新生成建议"),
  ).toBeVisible();
  expect(requests[0].body).toEqual({
    action: "apply",
    items: [
      { suggestion_id: "s-1", document_version: 1 },
      { suggestion_id: "s-2", document_version: 1 },
    ],
  });
  await user.click(
    within(results).getByRole("button", { name: "查看记录 / 撤销" }),
  );
  expect(showPlan).toHaveBeenCalledWith("applied-1");
});

it("过期建议可重新生成，发送当前文档版本，后台运行状态禁用重复触发", async () => {
  let refreshing = false;
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        refreshing = true;
        writes.push(JSON.parse(String(init.body)));
        return response({ job_id: "refresh-1", status: "queued" });
      }
      return response(
        page([
          {
            ...second,
            ...(refreshing
              ? { refresh_job_id: "refresh-1", refresh_status: "running" }
              : {}),
          },
        ]),
      );
    }),
  );
  mount(<Suggestions kbId={kb.id} onShowPlan={vi.fn()} />);
  const trigger = await screen.findByRole("button", {
    name: `重新生成建议：${second.document_name}`,
  });
  await userEvent.click(trigger);
  await screen.findByText("后台重新生成中…");
  expect(trigger).toBeDisabled();
  expect(writes).toEqual([{ document_version: 2 }]);
});

it("整理方案保存编辑后使用新版本审批，确认前零执行且目标位置始终可见", async () => {
  const requests: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      if (method !== "GET") {
        const body = JSON.parse(String(init?.body || "{}"));
        requests.push({ path, method, body });
        return response(
          method === "PATCH"
            ? {
                ...planRun.plan,
                version: 2,
                payload: {
                  ...planRun.plan!.payload,
                  operations: body.operations,
                },
              }
            : { status: "completed" },
        );
      }
      return response(path.endsWith("/folders") ? folders : []);
    }),
  );
  mount(<PlanEditor run={planRun} />);
  await screen.findByText("原建议名称");
  expect(screen.getAllByText("研究 / 方法").length).toBeGreaterThan(0);
  const user = userEvent.setup();
  await user.click(screen.getAllByText("调整参数")[1]);
  const name = screen.getByLabelText("名称");
  await user.clear(name);
  await user.type(name, "人工确认的名称");
  await user.click(screen.getByRole("button", { name: "批准所选并执行" }));
  const dialog = screen.getByRole("dialog", { name: "确认执行整理方案" });
  expect(within(dialog).getByText("原目录")).toBeVisible();
  expect(within(dialog).getByText("研究 / 方法")).toBeVisible();
  expect(requests).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].method).toBe("PATCH");
  expect((requests[0].body.operations as Operation[])[1].params.name).toBe(
    "人工确认的名称",
  );
  expect(requests[1].body).toEqual({
    plan_version: 2,
    confirm_high_risk: false,
  });
});

it("撤销遇到版本冲突显示错误，保留当前方案且不伪装成功", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? response(
            { code: "undo_conflict", message: "文档已被修改，无法撤销" },
            409,
          )
        : response(path.endsWith("/folders") ? folders : []),
    ),
  );
  mount(
    <PlanEditor
      run={{
        ...planRun,
        status: "completed",
        plan: { ...planRun.plan!, status: "completed" },
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "撤销此次整理" }));
  await userEvent.click(screen.getByRole("button", { name: "确认撤销" }));
  expect(
    (await screen.findAllByRole("alert")).some((node) =>
      node.textContent?.includes("文档已被修改，无法撤销"),
    ),
  ).toBe(true);
  expect(screen.getByRole("dialog", { name: "撤销此次整理" })).toBeVisible();
});

it("自动整理只创建后台待审任务，不自动批准或修改文档", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        return response({
          id: "new-run",
          kb_id: kb.id,
          status: "queued",
          goal: "按主题整理",
        });
      }
      return response({
        items: [{ id: "doc-1", display_name: "研究方法.pdf" }],
        total: 1,
      });
    }),
  );
  const created = vi.fn();
  mount(
    <CreatePlan
      knowledgeBases={[kb]}
      initialKbId={kb.id}
      onClose={vi.fn()}
      onCreated={created}
    />,
  );
  await screen.findByText("整理范围 · 已选 1 / 1 份文档");
  await userEvent.click(screen.getByRole("button", { name: "生成待审方案" }));
  await waitFor(() => expect(created).toHaveBeenCalledOnce());
  expect(requests).toEqual([
    {
      path: "/api/review/plans",
      body: { kb_id: kb.id, document_ids: ["doc-1"] },
    },
  ]);
});

it("知识库筛选进入统一建议请求，切换范围清理旧选择", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return response(path.startsWith("/api/agent/runs") ? [] : page([first]));
    }),
  );
  mount(
    <Review
      knowledgeBases={[kb, { ...kb, id: "kb-2", name: "第二库" }]}
      currentKbId={kb.id}
    />,
  );
  await screen.findByText(first.document_name);
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "选择本页建议" }));
  await user.click(screen.getByRole("combobox", { name: "筛选审阅知识库" }));
  await user.click(screen.getByRole("option", { name: "第二库" }));
  await waitFor(() =>
    expect(
      paths.some((path) => path.includes("/review/suggestions?kb_id=kb-2")),
    ).toBe(true),
  );
  expect(
    screen.getByRole("checkbox", { name: "选择本页建议" }),
  ).not.toBeChecked();
});
