import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Document, Section } from "../../lib/api";
import { DocumentReading } from "./DocumentReading";

vi.mock("./PdfViewer", () => ({ PdfViewer: () => <div>PDF画布</div> }));
afterEach(cleanup);
const document: Document = {
  id: "pdf",
  kb_id: "kb",
  folder_id: null,
  display_name: "资料.pdf",
  original_filename: "source.pdf",
  ext: "pdf",
  size_bytes: 100,
  version: 1,
  parse_status: "ready",
  index_status: "ready",
  summary_status: "ready",
  classification_status: "ready",
  created_at: "",
  tag_ids: [],
};
const sections: Section[] = [
  {
    id: "first",
    heading: "",
    plain_text: "第一页的正文",
    anchors: { page_start: 1, page_end: 1 },
  },
  {
    id: "third",
    heading: "",
    plain_text: "第三页的正文",
    anchors: { page_start: 3, page_end: 3 },
  },
];
it("PDF 默认只显示原件，文字页独立切换并仅显示当前页", async () => {
  const change = vi.fn();
  render(
    <MemoryRouter>
      <DocumentReading
        document={document}
        sections={sections}
        page={3}
        onPageChange={change}
        loading={false}
        error={null}
        retry={vi.fn()}
        tasksUrl="/tasks"
        active
        onLocate={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("PDF画布")).toBeVisible();
  expect(screen.getByText("第三页的正文")).not.toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "文字" }));
  expect(screen.getByText("PDF画布")).not.toBeVisible();
  expect(screen.getByText("第三页的正文")).toBeVisible();
  expect(screen.queryByText("第一页的正文")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "上一页" }));
  expect(change).toHaveBeenCalledWith(2);
  await user.click(screen.getByRole("tab", { name: "文字" }));
  await user.keyboard("{Home}");
  expect(screen.getByRole("tab", { name: "原件" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
it("引用片段默认紧凑，展开和定位不改来源页", async () => {
  const locate = vi.fn();
  render(
    <MemoryRouter>
      <DocumentReading
        document={document}
        sections={sections}
        citation={{
          document_id: "pdf",
          chunk_id: "chunk",
          snippet: "真实引用片段",
          anchors: { page_start: 3 },
        }}
        page={3}
        onPageChange={vi.fn()}
        loading={false}
        error={null}
        retry={vi.fn()}
        tasksUrl="/tasks"
        active
        onLocate={locate}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("真实引用片段")).toHaveClass("is-compact");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "展开片段" }));
  expect(screen.getByText("真实引用片段")).not.toHaveClass("is-compact");
  await user.click(screen.getByRole("button", { name: "定位" }));
  expect(locate).toHaveBeenCalledOnce();
});

it("HTML正文按纯文本阅读，不执行标签、脚本或远程资源", () => {
  const source =
    '<script>window.stolen=true</script><img src="https://untrusted.invalid/pixel">正文';
  render(
    <MemoryRouter>
      <DocumentReading
        document={{
          ...document,
          id: "html",
          ext: "html",
          preview_type: "text",
        }}
        sections={[
          {
            id: "html-section",
            heading: "网页正文",
            plain_text: source,
            anchors: { paragraph_start: 1 },
          },
        ]}
        page={1}
        onPageChange={vi.fn()}
        loading={false}
        error={null}
        retry={vi.fn()}
        tasksUrl="/tasks"
        active
        onLocate={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText(source)).toBeVisible();
  expect(window.document.querySelector("script, img, iframe")).toBeNull();
  expect(screen.queryByText("PDF画布")).not.toBeInTheDocument();
  expect(
    screen.getByText("显示提取的正文与来源位置；完整排版请下载原文件。"),
  ).toBeVisible();
});

it("工作表引用仅高亮对应表的行，章节可以收起而不改变来源", async () => {
  const repeated = "两张工作表都有这段内容";
  const sheets = [1, 2].map((index) => ({
    id: `sheet-${index}`,
    heading: index === 1 ? "收入" : "成本",
    plain_text: repeated,
    anchors: {
      sheet_index: index,
      sheet_name: index === 1 ? "收入" : "成本",
      row_start: 1,
      row_end: 20,
    },
  }));
  render(
    <MemoryRouter>
      <DocumentReading
        document={{ ...document, id: "xlsx", ext: "xlsx" }}
        sections={sheets}
        citation={{
          document_id: "xlsx",
          chunk_id: "chunk",
          anchors: { sheet_index: 2, sheet_name: "成本", row_start: 7 },
        }}
        page={1}
        onPageChange={vi.fn()}
        loading={false}
        error={null}
        retry={vi.fn()}
        tasksUrl="/tasks"
        active
        onLocate={vi.fn()}
      />
    </MemoryRouter>,
  );
  const highlighted = window.document.querySelectorAll(
    ".text-section.highlighted",
  );
  expect(highlighted).toHaveLength(1);
  expect(highlighted[0]).toHaveAttribute("data-section-id", "sheet-2");
  const details = screen.getByText("成本").closest("details")!;
  expect(details).toHaveAttribute("open");
  await userEvent.click(screen.getByText("成本"));
  expect(details).not.toHaveAttribute("open");
});

it("长记录每组只渲染40节，跨组引用直接可见并能重新定位", async () => {
  const longSections = Array.from({ length: 1000 }, (_, index) => ({
    id: `record-${index}`,
    heading: `记录 ${index + 1}`,
    plain_text: `正文 ${index + 1}`,
    anchors: { record_start: index + 1, record_end: index + 1 },
  }));
  const locate = vi.fn();
  render(
    <MemoryRouter>
      <DocumentReading
        document={{ ...document, id: "jsonl", ext: "jsonl" }}
        sections={longSections}
        citation={{
          document_id: "jsonl",
          chunk_id: "record-900",
          snippet: "目标记录片段",
          anchors: { record_start: 901 },
        }}
        page={1}
        onPageChange={vi.fn()}
        loading={false}
        error={null}
        retry={vi.fn()}
        tasksUrl="/tasks"
        active
        onLocate={locate}
      />
    </MemoryRouter>,
  );
  expect(window.document.querySelectorAll(".text-section")).toHaveLength(40);
  expect(screen.getByText("正文 901", { exact: true })).toBeVisible();
  expect(screen.queryByText("正文 1", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "上一组" }));
  expect(
    screen.queryByText("正文 901", { exact: true }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "定位" }),
  );
  expect(screen.getByText("正文 901", { exact: true })).toBeVisible();
  expect(locate).toHaveBeenCalledOnce();
});
