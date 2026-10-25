import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatProgress } from "./ChatProgress";
import type { ChatStep, Citation, Message } from "../../lib/api";

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

const activity = (overrides: Partial<ChatStep>): ChatStep => step({
  stage: "tool_activity", tool_name: "search_knowledge", call_id: "search-one", ...overrides,
});
const source: Citation = {
  ordinal: 0, document_id: "policy", chunk_id: "page-three", document_name: "推免政策.pdf",
  snippet: "普通推免144人，专项推免21人。", anchors: { page_start: 3 },
  kb_name: "政策库", ext: "pdf", available: true,
};
const thinking = (execution: ChatStep[], status = "completed"): Message => ({
  ...message(execution, status), retrieval: { execution, retrieval_mode: "model" },
});

it("新过程按真实调用去重，保留范围与检索词且不重复展示搜索汇总或内部规划", async () => {
  render(<ChatProgress message={thinking([
    activity({ status: "running", query: "学院 推免名额" }),
    activity({ source_count: 5, query: "学院 推免名额", detail: "找到5条相关片段" }),
    step({ stage: "search_round_summary", source_count: 5, queries: ["学院 推免名额"] }),
    activity({ tool_name: "list_documents", call_id: "documents", result_count: 2, query: "推免", detail: "找到2份资料" }),
    step({ stage: "tool_planning", label: "内部规划绝不展示", query: "隐藏查询" }),
    activity({ tool_name: "run_shell", call_id: "unknown", detail: "未知工具不显示" }),
  ])} />);
  expect(document.querySelector(".chat-activity-progress")).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("思考过程"));
  expect(screen.getByText("已完成 · 2 项查阅")).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("5 条相关片段")).toBeVisible();
  expect(screen.queryByText("已检索到 5 条信息")).not.toBeInTheDocument();
  expect(screen.queryByText(/内部规划绝不展示|隐藏查询|未知工具不显示/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("知识库搜索"));
  expect(within(screen.getByText("知识库搜索").closest("li")!).getByText("范围 · 课程库 / Python")).toBeVisible();
  expect(screen.getByText("找到5条相关片段")).toBeVisible();
});

it("运行时展开真实活动，新增完成状态替换同一行，结束后自动收起且支持键盘展开", async () => {
  const mounted = render(<ChatProgress message={thinking([activity({ status: "running", query: "名额" })], "processing")} />);
  expect(document.querySelector(".chat-activity-progress")).toHaveAttribute("open");
  expect(screen.getByText("进行中")).toBeVisible();
  mounted.rerender(<ChatProgress message={thinking([
    activity({ status: "running", query: "名额" }), activity({ source_count: 4, query: "名额" }),
  ], "processing")} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText("4 条相关片段")).toBeVisible();
  mounted.rerender(<ChatProgress message={thinking([activity({ source_count: 4, query: "名额" })])} />);
  const summary = screen.getByText("思考过程").closest("summary")!;
  expect(document.querySelector(".chat-activity-progress")).not.toHaveAttribute("open");
  summary.focus();
  expect(summary).toHaveFocus();
  await userEvent.click(summary);
  expect(document.querySelector(".chat-activity-progress")).toHaveAttribute("open");
});

it("已浏览原文保留真实页码并复用既有引用打开链路", async () => {
  const onOpen = vi.fn();
  render(<ChatProgress onOpenSource={onOpen} message={thinking([
    activity({ tool_name: "get_document_outline", call_id: "outline", document_name: "推免政策.pdf", result_count: 6 }),
    activity({ tool_name: "read_document", call_id: "read", document_name: "推免政策.pdf", source_count: 2, source }),
  ])} />);
  await userEvent.click(screen.getByText("思考过程"));
  expect(screen.getByText("浏览文档目录")).toBeVisible();
  expect(screen.getByText("已读 2 个片段")).toBeVisible();
  expect(screen.getByText("第 3 页")).toBeVisible();
  const open = screen.getByRole("button", { name: "打开查阅原文：推免政策.pdf" });
  await userEvent.click(open);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(source);
});

it.each([
  { available: false, source },
  { source: { ...source, available: false } },
])("不可用的工具来源遮蔽名称、旧片段、范围和说明，不能继续打开：%j", async (redaction) => {
  const onOpen = vi.fn();
  render(<ChatProgress onOpenSource={onOpen} message={thinking([
    activity({ tool_name: "read_document", call_id: "read", document_name: "旧名称.pdf", query: "旧搜索词", detail: "旧私密说明", ...redaction }),
  ])} />);
  await userEvent.click(screen.getByText("思考过程"));
  expect(screen.getByText("资料已不可用")).toBeVisible();
  expect(screen.queryByText(/旧名称|旧搜索词|旧私密说明|普通推免144|课程库/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /打开查阅原文/ })).not.toBeInTheDocument();
  expect(onOpen).not.toHaveBeenCalled();
});

it("最新活动快照删除source时不会继承旧来源，快速查阅保留失败状态且不伪造零结果", async () => {
  const quick = message([
    activity({ tool_name: "read_document", call_id: "read", source, document_name: "旧名称.pdf" }),
    activity({ tool_name: "read_document", call_id: "read", available: false }),
    activity({ call_id: "failed", status: "failed", query: "失败查询", source_count: undefined }),
  ], "failed");
  quick.retrieval!.retrieval_mode = "direct";
  render(<ChatProgress message={quick} onOpenSource={vi.fn()} />);
  await userEvent.click(screen.getByText("快速查阅"));
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("资料已不可用")).toBeVisible();
  expect(screen.queryByText(/旧名称|推免政策|0 条/)).not.toBeInTheDocument();
  expect(screen.getByText("未完成 · 2 项查阅")).toBeVisible();
});

it("快速模式使用同一过程入口展示固定检索，缺少模式的旧消息仍保留原标题", async () => {
  const quick = message([step({ stage: "search_round_summary", queries: ["名额"], source_count: 3 })]);
  quick.retrieval!.retrieval_mode = "direct";
  const mounted = render(<ChatProgress message={quick} />);
  await userEvent.click(screen.getByText("快速查阅"));
  expect(screen.getByText("已完成 · 1 轮查阅")).toBeVisible();
  expect(screen.getByText("已检索到 3 条信息")).toBeVisible();
  mounted.rerender(<ChatProgress message={message([step({ stage: "search_round_summary", source_count: 3 })])} />);
  expect(screen.getByText("已完成资料查阅")).toBeVisible();
});

it("工具规划回退为直接查阅时公开确定性说明，不把回退算作额外工具调用", async () => {
  render(<ChatProgress message={thinking([
    step({ stage: "retrieval_fallback", label: "已转为直接检索", notice: "模型检索规划暂不可用，已沿用直接检索", error_code: "read_timeout" }),
    activity({ call_id: "tool-fallback-search", query: "原问题", source_count: 4 }),
  ])} />);
  expect(screen.getByText("已转为直接查阅 · 1 项查阅")).toBeVisible();
  await userEvent.click(screen.getByText("思考过程"));
  expect(screen.getByRole("status")).toHaveTextContent("模型检索规划暂不可用，已沿用直接检索");
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
});

it.each([
  { notice: "部分检索暂不可用，已保留已找到的资料", error_code: "planning_budget_exhausted", expected: "部分检索暂不可用，已保留已找到的资料" },
  { notice: "ProviderError: raw-secret request at C:/private/debug", error_code: "read_timeout", expected: "工具规划响应超时，已沿用可用资料。" },
])("沿用已有证据时如实说明降级；未知旧异常只按错误码显示固定文案：$error_code", async ({ notice, error_code, expected }) => {
  render(<ChatProgress message={thinking([
    activity({ source_count: 3 }),
    step({ stage: "retrieval_fallback", label: "检索已停止，沿用可用资料", notice, error_code }),
  ])} />);
  expect(screen.getByText("已沿用可用资料 · 1 项查阅")).toBeVisible();
  await userEvent.click(screen.getByText("思考过程"));
  expect(screen.getByRole("status")).toHaveTextContent(expected);
  expect(screen.queryByText(/raw-secret|ProviderError|private\/debug/)).not.toBeInTheDocument();
});
