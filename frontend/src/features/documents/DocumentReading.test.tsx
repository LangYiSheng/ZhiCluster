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
  expect(
    screen.getByRole("tab", { name: "原件" }),
  ).toHaveAttribute("aria-selected", "true");
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
  await user.click(
    screen.getByRole("button", { name: "展开片段" }),
  );
  expect(screen.getByText("真实引用片段")).not.toHaveClass("is-compact");
  await user.click(screen.getByRole("button", { name: "定位" }));
  expect(locate).toHaveBeenCalledOnce();
});
