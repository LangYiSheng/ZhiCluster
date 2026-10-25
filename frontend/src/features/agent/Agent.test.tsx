import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agent } from "./Agent";
import type { Operation } from "../../lib/api";
const operations = [
  {
    operation_id: "rename-1",
    type: "rename_document",
    target_ids: ["doc-1"],
    params: { name: "原始名称" },
    description: "重命名一个文档",
    dependencies: [],
    enabled: true,
    reversible: true,
  },
];
let requests: {
  path: string;
  method: string;
  body: Record<string, unknown>;
}[] = [];
function setup(
  ops: Operation[] = operations,
  extraPayload: { base_tag_links?: Record<string, string[]> } = {},
) {
  const payload = {
    summary: "待审批计划",
    operations: ops,
    expected_changes: 1,
    risk_level: "low",
    base_versions: { "doc-1": 1 },
    ...extraPayload,
  };
  let version = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ path, method, body });
      if (method === "PATCH") {
        version++;
        return new Response(
          JSON.stringify({
            id: "plan-1",
            version,
            status: "pending_review",
            payload: { ...payload, operations: body.operations },
          }),
        );
      }
      if (path.endsWith("/approve"))
        return new Response(JSON.stringify({ status: "completed" }));
      return new Response(
        JSON.stringify({
          id: "run-1",
          status: "pending_review",
          goal: "整理文档",
          plan: { id: "plan-1", version, status: "pending_review", payload },
          events: [],
        }),
      );
    }),
  );
  localStorage.setItem("agent:kb-1", "run-1");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Agent kbId="kb-1" folders={[]} tags={[]} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  requests = [];
  localStorage.clear();
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
  vi.unstubAllGlobals();
});
describe("Agent整批审批前端（明确使用受控测试响应）", () => {
  it("移动到知识库根目录仍提交folder_id=null", async () => {
    setup([
      {
        ...operations[0],
        type: "move_documents",
        description: "返回知识库根目录",
        params: { folder_id: "old-folder" },
      },
    ]);
    const user = userEvent.setup();
    const destination = await screen.findByRole("combobox", {
      name: "目标文件夹",
    });
    await user.click(destination);
    await user.click(screen.getByRole("option", { name: "知识库根目录" }));
    expect(destination).toHaveTextContent("知识库根目录");
    await user.click(
      screen.getByRole("button", { name: "批准整个计划并执行" }),
    );
    await waitFor(() =>
      expect(requests.some((item) => item.method === "PATCH")).toBe(true),
    );
    const saved = requests.find((item) => item.method === "PATCH")!;
    expect(
      (saved.body.operations as Operation[])[0].params.folder_id,
    ).toBeNull();
  });
  it("先保存用户编辑后的参数，再批准保存版本", async () => {
    setup();
    const user = userEvent.setup();
    const input = await screen.findByLabelText("名称");
    await user.clear(input);
    await user.type(input, "用户最终名称");
    await user.click(
      screen.getByRole("button", { name: "批准整个计划并执行" }),
    );
    await waitFor(() =>
      expect(requests.some((r) => r.path.endsWith("/approve"))).toBe(true),
    );
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect((patch.body.operations as typeof operations)[0].params.name).toBe(
      "用户最终名称",
    );
    expect(requests.find((r) => r.path.endsWith("/approve"))?.body).toEqual({
      plan_version: 2,
      confirm_high_risk: false,
    });
    expect(requests.indexOf(patch)).toBeLessThan(
      requests.findIndex((r) => r.path.endsWith("/approve")),
    );
  });
  it("软删除在独立确认前不发送批准请求", async () => {
    setup([
      {
        ...operations[0],
        type: "trash_documents",
        params: { name: "" },
        description: "软删除文档",
      },
    ]);
    const user = userEvent.setup();
    await screen.findByText("软删除文档");
    await user.click(
      screen.getByRole("button", { name: "批准整个计划并执行" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "确认高风险操作" }),
    ).toBeVisible();
    expect(requests.some((r) => r.path.endsWith("/approve"))).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "明确确认删除并执行整批计划" }),
    );
    await waitFor(() =>
      expect(
        requests.find((r) => r.path.endsWith("/approve"))?.body
          .confirm_high_risk,
      ).toBe(true),
    );
  });
  it("新标签删除先显示影响关联，再经独立确认批准", async () => {
    setup(
      [
        {
          ...operations[0],
          type: "delete_tags",
          target_ids: ["tag-1"],
          params: {},
          description: "删除废弃标签",
        },
      ],
      { base_tag_links: { "tag-1": ["doc-1", "doc-2"] } },
    );
    const user = userEvent.setup();
    await screen.findByText("删除标签");
    await user.click(
      screen.getByRole("button", { name: "批准整个计划并执行" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "确认高风险操作" }),
    ).toBeVisible();
    expect(
      screen.getByText(/删除 1 个标签，并移除 2 份文档上的关联/),
    ).toBeVisible();
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" || request.path.endsWith("/approve"),
      ),
    ).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "明确确认删除并执行整批计划" }),
    );
    await waitFor(() =>
      expect(
        requests.find((request) => request.path.endsWith("/approve"))?.body,
      ).toEqual({
        plan_version: 1,
        confirm_high_risk: true,
      }),
    );
  });
});
