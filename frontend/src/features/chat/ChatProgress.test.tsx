import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatProgress } from "./ChatProgress";
import type { ChatStep, Message } from "../../lib/api";

afterEach(cleanup);
const step = (overrides: Partial<ChatStep>): ChatStep => ({
  stage: "search", label: "内部检索阶段", status: "completed", round: 1,
  scope_key: "scope-one", scope_label: "课程库 / Python", ...overrides,
});
const message = (execution: ChatStep[], status = "completed"): Message => ({
  id: "message", role: "assistant", content: "回答", status,
  retrieval: { execution, notice: "关键词 + 各知识库绑定模型的精确 cosine 检索，按排名融合" },
});

it("同轮搜索词合成圆角项，计数采用本轮去重结果并隐藏所有内部阶段", async () => {
  render(<ChatProgress message={message([
    step({ stage: "scope", label: "检查知识范围" }),
    step({ stage: "tool_planning", label: "模型检索规划第 1 轮", elapsed_ms: 7700 }),
    step({ query: "关系运算符 定义 常见符号", call_id: "first" }),
    step({ stage: "keyword", query: "关系运算符 定义 常见符号", source_count: 16 }),
    step({ stage: "search_result", query: "关系运算符 定义 常见符号", source_count: 16 }),
    step({ query: "关系运算符 大于 小于 等于", call_id: "second" }),
    step({ stage: "search_result", query: "关系运算符 大于 小于 等于", source_count: 16 }),
    step({ stage: "search_round_summary", queries: ["关系运算符 定义 常见符号", "关系运算符 大于 小于 等于"], source_count: 22 }),
    step({ stage: "context", label: "整理参考资料", source_count: 22 }),
  ])} />);
  const details = document.querySelector("details")!;
  expect(details).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("已完成资料查阅"));
  expect(document.querySelectorAll(".chat-search-round")).toHaveLength(1);
  expect(screen.getByText("在课程库 / Python中查找相关资料")).toBeVisible();
  expect(within(screen.getByRole("list", { name: "检索词" })).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("已检索到 22 条信息")).toBeVisible();
  expect(screen.queryByText(/32 条|7.7|cosine|检查知识范围|模型检索规划|整理参考资料/)).not.toBeInTheDocument();
});

it("不同范围和不同轮次独立展示，不混加来源数", async () => {
  render(<ChatProgress message={message([
    step({ stage: "search_round_summary", queries: ["比较运算符"], source_count: 3 }),
    step({ stage: "search_round_summary", scope_key: "scope-two", scope_label: "课程库 / 数据结构 / 重点标签", queries: ["关系运算"], source_count: 2 }),
    step({ stage: "search_round_summary", round: 2, queries: ["运算优先级"], source_count: 0 }),
  ])} />);
  await userEvent.click(screen.getByText("已完成资料查阅"));
  expect(screen.getByText("2 轮查阅")).toBeVisible();
  expect(document.querySelectorAll(".chat-search-round")).toHaveLength(3);
  for (const count of [3, 2, 0]) expect(screen.getByText("已检索到 " + count + " 条信息")).toBeVisible();
});

it("流中新增搜索时等待新计数，更新后保留用户展开状态", async () => {
  const first = step({ stage: "search_round_summary", queries: ["第一个查询"], source_count: 4 });
  const mounted = render(<ChatProgress message={message([first], "processing")} />);
  await userEvent.click(screen.getByText("正在查找资料"));
  mounted.rerender(<ChatProgress message={message([first, step({ query: "第二个查询", status: "running" })], "processing")} />);
  expect(screen.getByText("正在检索…")).toBeVisible();
  expect(screen.queryByText("已检索到 4 条信息")).not.toBeInTheDocument();
  mounted.rerender(<ChatProgress message={message([first, step({ stage: "search_round_summary", queries: ["第一个查询", "第二个查询"], source_count: 6 })])} />);
  expect(document.querySelector("details")).toHaveAttribute("open");
  expect(screen.getByText("已检索到 6 条信息")).toBeVisible();
});

it("旧直接检索复用真实最终数量；搜索失败不捏造零结果", async () => {
  const mounted = render(<ChatProgress message={message([
    step({ stage: "keyword", scope_key: undefined, scope_label: undefined, query: "旧搜索" }),
    step({ stage: "context", scope_key: undefined, scope_label: undefined, source_count: 7 }),
  ])} />);
  await userEvent.click(screen.getByText("已完成资料查阅"));
  expect(screen.getByText("已检索到 7 条信息")).toBeVisible();
  mounted.rerender(<ChatProgress message={message([step({ query: "失败搜索", status: "failed" })], "failed")} />);
  expect(screen.getByText("此次查找未完成")).toBeVisible();
  expect(screen.queryByText("已检索到 0 条信息")).not.toBeInTheDocument();
});

it("真实旧向量进度的queries数量不是搜索词，回放旧消息不崩溃", async () => {
  render(<ChatProgress message={message([
    step({ stage: "keyword", scope_key: undefined, scope_label: undefined }),
    step({ stage: "embedding", scope_key: undefined, scope_label: undefined, queries: 2 }),
    step({ stage: "ranking", scope_key: undefined, scope_label: undefined }),
    step({ stage: "context", scope_key: undefined, scope_label: undefined, source_count: 16 }),
    step({ stage: "generation" }),
  ])} />);
  await userEvent.click(screen.getByText("已完成资料查阅"));
  expect(screen.getByText("已检索到 16 条信息")).toBeVisible();
  expect(document.querySelectorAll(".chat-search-query")).toHaveLength(0);
});

it("流中旧数字计数之后到达新summary时保留合法查询和数量", async () => {
  const embedding = step({ stage: "embedding", queries: 2, status: "running" });
  const mounted = render(<ChatProgress message={message([embedding], "processing")} />);
  await userEvent.click(screen.getByText("正在查找资料"));
  mounted.rerender(<ChatProgress message={message([
    { ...embedding, status: "completed" },
    step({ stage: "search_round_summary", queries: ["operator", "comparison"], source_count: 3 }),
  ])} />);
  expect(document.querySelector("details")).toHaveAttribute("open");
  expect(screen.getByText("operator")).toBeVisible();
  expect(screen.getByText("comparison")).toBeVisible();
  expect(screen.getByText("已检索到 3 条信息")).toBeVisible();
});

it.each([
  { queries: null, expected: "单条实际查询" },
  { queries: "旧文本", expected: "单条实际查询" },
  { queries: true, expected: "单条实际查询" },
  { queries: { count: 2 }, expected: "单条实际查询" },
  { queries: [null, 2, "  合法查询  ", { value: "坏值" }], expected: "合法查询" },
])("API中非数组或混合查询字段安全降级，不隐藏合法数据：$queries", async ({ queries, expected }) => {
  const raw = { ...step({ stage: "search_round_summary", query: "单条实际查询", source_count: 4 }), queries } as unknown as ChatStep;
  render(<ChatProgress message={message([raw])} />);
  await userEvent.click(screen.getByText("已完成资料查阅"));
  expect(screen.getByText(expected)).toBeVisible();
  expect(document.querySelectorAll(".chat-search-query")).toHaveLength(1);
  expect(screen.getByText("已检索到 4 条信息")).toBeVisible();
});

it.each([null, 2, "旧执行数据", { stage: "embedding" }])("无效execution容器不会使页面崩溃：%j", (execution) => {
  const raw = message([]);
  raw.retrieval!.execution = execution as unknown as ChatStep[];
  const mounted = render(<ChatProgress message={raw} />);
  expect(mounted.container).toBeEmptyDOMElement();
});

it("跳过空的或无结构步骤，非法范围名称和结果类型不影响合法搜索", async () => {
  const raw = message([]);
  raw.retrieval!.execution = [null, 2, "坏步骤", [], {}, {
    stage: "search_round_summary", queries: ["真实查询"], source_count: "2",
    scope_label: { name: "错误结构" }, scope_key: {}, round: {},
  }] as unknown as ChatStep[];
  render(<ChatProgress message={raw} />);
  await userEvent.click(screen.getByText("已完成资料查阅"));
  expect(screen.getByText("在当前知识范围中查找相关资料")).toBeVisible();
  expect(screen.getByText("真实查询")).toBeVisible();
  expect(screen.queryByText("已检索到 2 条信息")).not.toBeInTheDocument();
});
