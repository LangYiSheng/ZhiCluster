import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

it("来源列表只显示实际引用的条目，处理完成自动收起并能回看真实阶段", async () => {
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
  expect(document.querySelector("details")).toHaveAttribute("open");
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
  expect(screen.getByText("关键词检索")).toBeVisible();
  expect(screen.getByText("42 ms")).toBeVisible();
});
