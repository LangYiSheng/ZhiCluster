import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CitationPreview } from "./CitationPreview";
import { CitationList, MessageContent } from "./MessageContent";
import type { Citation } from "../../lib/api";

afterEach(cleanup);
const source: Citation = {
  ordinal: 1,
  document_id: "doc-one",
  chunk_id: "chunk-one",
  document_name: "关系运算符.pdf",
  snippet:
    "关系运算符比较两个值，结果为真或假。<script>这里只是资料文字</script>",
  ext: "pdf",
  kb_id: "kb-one",
  kb_name: "Python课程",
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

it("悬停显示真实片段及格式知识库，卡片通过Portal放在段落外，移入后保留直到离开", async () => {
  render(
    <MessageContent
      content="参考[S1]。"
      citations={[source]}
      onCitation={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "查看来源 1：关系运算符.pdf",
  });
  expect(trigger).not.toHaveAttribute("title");
  const user = userEvent.setup();
  await user.hover(trigger);
  const card = await screen.findByRole("tooltip", {
    name: "来源预览：关系运算符.pdf",
  });
  expect(within(card).getByText(source.snippet!)).toBeVisible();
  expect(card).toHaveTextContent("PDF");
  expect(card).toHaveTextContent("@ Python课程");
  expect(document.querySelector(".markdown p")).not.toContainElement(card);
  expect(card.querySelector("script")).toBeNull();
  await user.hover(card);
  await sleep(260);
  expect(card).toBeVisible();
  await user.unhover(card);
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
});

it("键盘聚焦展示且不抢焦点，Escape立即关闭并保留编号焦点", async () => {
  render(
    <>
      <CitationPreview citation={source} label="引用预览" onCitation={vi.fn()}>
        1
      </CitationPreview>
      <button>下一项</button>
    </>,
  );
  const user = userEvent.setup();
  await user.tab();
  const trigger = screen.getByRole("button", { name: "引用预览" });
  expect(trigger).toHaveFocus();
  const card = await screen.findByRole("tooltip");
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-describedby", card.id);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  await sleep(260);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole("button", { name: "下一项" })).toHaveFocus();
});

it("点击直接打开原引用，并取消已安排的悬停预览", async () => {
  const open = vi.fn();
  render(
    <CitationPreview citation={source} label="引用预览" onCitation={open}>
      1
    </CitationPreview>,
  );
  await userEvent.click(screen.getByRole("button", { name: "引用预览" }));
  expect(open).toHaveBeenCalledExactlyOnceWith(source);
  await sleep(280);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("触屏保留原生单次点击，不取消touchstart或显示悬停卡片", async () => {
  const open = vi.fn();
  render(
    <CitationPreview citation={source} label="引用预览" onCitation={open}>
      1
    </CitationPreview>,
  );
  const trigger = screen.getByRole("button", { name: "引用预览" });
  fireEvent.pointerDown(trigger, { pointerType: "touch" });
  expect(fireEvent.touchStart(trigger)).toBe(true);
  fireEvent.focus(trigger);
  fireEvent.pointerUp(trigger, { pointerType: "touch" });
  fireEvent.click(trigger);
  expect(open).toHaveBeenCalledExactlyOnceWith(source);
  await sleep(280);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("切换来源取消旧计时器；引用失效时立即移除旧片段并禁止打开", async () => {
  const open = vi.fn();
  const view = (citation: Citation) => (
    <CitationPreview citation={citation} label="引用预览" onCitation={open}>
      1
    </CitationPreview>
  );
  const mounted = render(view(source));
  const user = userEvent.setup();
  await user.hover(screen.getByRole("button", { name: "引用预览" }));
  const next = {
    ...source,
    document_id: "doc-two",
    chunk_id: "chunk-two",
    document_name: "新资料.docx",
    snippet: "新的真实片段",
  };
  mounted.rerender(view(next));
  await sleep(280);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.hover(screen.getByRole("button", { name: "引用预览" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("新的真实片段");
  mounted.rerender(view({ ...next, available: false }));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.queryByText("新的真实片段")).not.toBeInTheDocument();
  const unavailable = screen.getByRole("button", { name: "引用预览" });
  expect(unavailable).toBeDisabled();
  await user.hover(unavailable);
  await user.click(unavailable);
  expect(open).not.toHaveBeenCalled();
});

it("旧引用可从文件名推断格式，缺少或非法知识库信息不会编造底栏", async () => {
  render(
    <CitationPreview
      citation={{ ...source, ext: null, kb_name: null }}
      label="引用预览"
      onCitation={vi.fn()}
    >
      1
    </CitationPreview>,
  );
  await userEvent.hover(screen.getByRole("button", { name: "引用预览" }));
  const card = await screen.findByRole("tooltip");
  expect(card).toHaveTextContent("PDF");
  expect(card.querySelector(".citation-preview-library")).toBeNull();
});

it("来源列表的失效旧数据不泄露名称、片段、知识库或定位信息", async () => {
  const open = vi.fn();
  render(
    <CitationList
      content="回答[S1]"
      citations={[
        {
          ...source,
          available: false,
          anchors: { chapter_title: "旧私有章节" },
        },
      ]}
      onCitation={open}
    />,
  );
  const trigger = screen.getByRole("button", { name: "来源不可用 1" });
  expect(trigger).toBeDisabled();
  expect(document.body.innerHTML).not.toContain(source.document_name);
  expect(document.body.innerHTML).not.toContain(source.snippet);
  expect(document.body.innerHTML).not.toContain(source.kb_name);
  expect(document.body.innerHTML).not.toContain("旧私有章节");
  await userEvent.hover(trigger);
  await sleep(260);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(open).not.toHaveBeenCalled();
});
