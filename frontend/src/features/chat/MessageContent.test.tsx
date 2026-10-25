import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CitationList, MessageContent } from "./MessageContent";
import { ChatProgress } from "./ChatProgress";
import type { Citation } from "../../lib/api";

afterEach(cleanup);
const sources: Citation[] = [
  {
    ordinal: 5,
    document_id: "doc-5",
    chunk_id: "chunk-5",
    document_name: "推免细则.pdf",
    anchors: { page_start: 3 },
  },
  {
    ordinal: 8,
    document_id: "doc-8",
    chunk_id: "chunk-8",
    document_name: "已删除文档",
    available: false,
  },
];

it("正文中的来源标记使用真实序号，可点击，代码与链接内不解析", async () => {
  const open = vi.fn();
  render(
    <MessageContent
      content={
        "依据[S5]，不可用[S8]，未知[S999]。`[S5]`\n\n```txt\n[S5]\n```\n\n[普通链接[S5]](https://example.com)"
      }
      citations={sources}
      onCitation={open}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "查看来源 5：推免细则.pdf" }),
  );
  expect(open).toHaveBeenCalledWith(sources[0]);
  expect(screen.getByRole("button", { name: "引用 8 不可用" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "引用 999 不可用" }),
  ).toBeDisabled();
  expect(document.querySelectorAll("code")).toHaveLength(2);
  expect(document.querySelectorAll("code button")).toHaveLength(0);
  expect(screen.getByRole("link", { name: "普通链接[S5]" })).toBeVisible();
  expect(screen.getAllByRole("button")).toHaveLength(3);
});

it("来源只显示实际引用，查阅过程默认压缩一行且完成后能展开回看", async () => {
  render(
    <CitationList
      content="回答[S5]"
      citations={sources}
      onCitation={vi.fn()}
    />,
  );
  expect(screen.getByRole("list")).toBeVisible();
  expect(screen.queryByText("已删除文档")).not.toBeInTheDocument();
  const message = {
    id: "m",
    role: "assistant",
    content: "",
    status: "processing",
    retrieval: {
      execution: [
        { stage: "keyword", label: "关键词检索", status: "running" as const },
      ],
    },
  };
  const mounted = render(<ChatProgress message={message} />);
  expect(document.querySelector("details")).not.toHaveAttribute("open");
  expect(
    within(document.querySelector("summary")!).getByText("正在查找资料"),
  ).toBeVisible();
  mounted.rerender(
    <ChatProgress
      message={{
        ...message,
        status: "completed",
        retrieval: {
          execution: [
            {
              stage: "keyword",
              label: "关键词检索",
              status: "completed",
              elapsed_ms: 42,
            },
          ],
        },
      }}
    />,
  );
  expect(document.querySelector("details")).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("已完成资料查阅"));
  expect(screen.getByText("在当前知识范围中查找相关资料")).toBeVisible();
  expect(screen.getByText("已完成检索")).toBeVisible();
  expect(screen.queryByText("关键词检索")).not.toBeInTheDocument();
  expect(screen.queryByText("42 ms")).not.toBeInTheDocument();
});

it("来源默认单行预览，展开后显示全部真实引用且失效来源无法打开", async () => {
  const citations = [
    ...sources,
    ...[9, 10].map((ordinal) => ({
      ...sources[0],
      ordinal,
      chunk_id: `chunk-${ordinal}`,
      document_name: `附件${ordinal}.pdf`,
    })),
  ];
  const open = vi.fn();
  render(
    <CitationList
      content="依据[S5][S8][S9][S10]"
      citations={citations}
      onCitation={open}
    />,
  );
  const list = screen.getByRole("list");
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.queryByText("附件10.pdf")).not.toBeInTheDocument();
  await userEvent.click(
    within(list).getByRole("button", { name: /查看来源 5：推免细则/ }),
  );
  expect(open).toHaveBeenCalledWith(citations[0]);
  const expand = screen.getByRole("button", { name: "展开 4 项来源" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expand.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "收起来源" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  expect(
    within(list).getByRole("button", { name: "来源不可用 8" }),
  ).toBeDisabled();
  await userEvent.click(
    within(list).getByRole("button", { name: /查看来源 10：附件10/ }),
  );
  expect(open).toHaveBeenLastCalledWith(citations[3]);
  await userEvent.click(screen.getByRole("button", { name: "收起来源" }));
  expect(screen.queryByText("附件10.pdf")).not.toBeInTheDocument();
});

it("旧查询过程只保留搜索词和结果，工具字段、耗时与实现说明均隐藏", async () => {
  const message = {
    id: "m",
    role: "assistant",
    content: "",
    status: "processing",
    retrieval: {
      execution: [
        {
          stage: "search",
          label: "查找相关资料",
          status: "completed" as const,
          query: "推免名额",
          tool_name: "search_knowledge",
          call_id: "call-1",
          round: 2,
          source_count: 4,
        },
      ],
      notice: "关键词 + 当前模型精确 cosine 检索，复合问题分路融合",
    },
  };
  const mounted = render(<ChatProgress message={message} />);
  expect(screen.getByText("推免名额")).not.toBeVisible();
  expect(screen.getByText("1 轮查阅")).toBeVisible();
  await userEvent.click(screen.getByText("正在查找资料"));
  expect(screen.getByText("推免名额")).toBeVisible();
  expect(screen.getByText("已检索到 4 条信息")).toBeVisible();
  expect(screen.queryByText("搜索知识库 · 第 2 轮")).not.toBeInTheDocument();
  expect(screen.queryByText(/cosine/)).not.toBeInTheDocument();
  mounted.rerender(
    <ChatProgress
      message={{
        ...message,
        retrieval: {
          ...message.retrieval,
          notice: "仅关键词搜索：未配置 Embedding 服务",
        },
      }}
    />,
  );
  expect(
    screen.queryByText("尚未配置向量模型，可前往设置连接。"),
  ).not.toBeInTheDocument();
});
