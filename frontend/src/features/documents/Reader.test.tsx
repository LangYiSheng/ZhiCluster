import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render as renderView,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { Citation, Document, Job, Section } from "../../lib/api";
import { Reader } from "./Reader";
function render(ui: ReactElement) {
  return renderView(ui, { wrapper: MemoryRouter });
}

vi.mock("./PdfViewer", () => ({ PdfViewer: () => null }));

const previousScroll = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

it("跨组工作表引用在渲染目标组后定位，不命中另一张表的相同行号", async () => {
  const located: string[] = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(function (this: HTMLElement) {
      located.push(this.dataset.sectionId || "");
    }),
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const doc: Document = {
    id: "workbook",
    kb_id: "kb",
    folder_id: null,
    display_name: "预算.xlsx",
    original_filename: "预算.xlsx",
    ext: "xlsx",
    size_bytes: 100,
    version: 1,
    parse_status: "ready",
    index_status: "ready",
    summary_status: "not_configured",
    classification_status: "not_configured",
    created_at: "",
  };
  const sections: Section[] = [
    ...Array.from({ length: 80 }, (_, index) => ({
      id: `sheet-one-${index}`,
      heading: "收入",
      plain_text: `收入记录 ${index}`,
      anchors: {
        sheet_index: 1,
        sheet_name: "收入",
        row_start: index * 20 + 1,
        row_end: (index + 1) * 20,
      },
    })),
    {
      id: "sheet-two-target",
      heading: "成本",
      plain_text: "第二张表正文",
      anchors: {
        sheet_index: 2,
        sheet_name: "成本",
        row_start: 1,
        row_end: 20,
      },
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("/content")
              ? { text: "", sections }
              : path.includes("/ingestion/jobs")
                ? []
                : doc,
          ),
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Reader
        documentId={doc.id}
        reader
        onReader={vi.fn()}
        folders={[]}
        tags={[]}
        citation={{
          document_id: doc.id,
          chunk_id: "target",
          snippet: "目标表格引用",
          anchors: { sheet_index: 2, sheet_name: "成本", row_start: 7 },
        }}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("第二张表正文");
  await vi.waitFor(() => expect(located).toContain("sheet-two-target"));
  expect(located.some((id) => id.startsWith("sheet-one"))).toBe(false);
  expect(document.querySelectorAll(".text-section")).toHaveLength(1);
  const details = screen.getByText("成本").closest("details")!;
  await userEvent.click(screen.getByText("成本"));
  expect(details).not.toHaveAttribute("open");
  await userEvent.click(screen.getByRole("button", { name: "定位" }));
  await vi.waitFor(() => expect(details).toHaveAttribute("open"));
  client.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (previousScroll)
    Object.defineProperty(Element.prototype, "scrollIntoView", previousScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

it("隐藏引用在正文加载后等待激活再定位真实段落，切回隐藏不重复滚动", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const document: Document = {
    id: "doc-1",
    kb_id: "kb-1",
    folder_id: null,
    display_name: "引用资料",
    original_filename: "reference.txt",
    ext: "txt",
    size_bytes: 120,
    version: 1,
    parse_status: "ready",
    index_status: "ready",
    summary_status: "not_configured",
    classification_status: "not_configured",
    created_at: "2026-10-23T00:00:00Z",
    tag_ids: [],
  };
  const sections: Section[] = [
    {
      id: "section-before",
      heading: "前文",
      plain_text: "另一段正文",
      anchors: { line_start: 1, line_end: 4 },
    },
    {
      id: "section-target",
      heading: "引用所在段落",
      plain_text: "目标段落原文",
      anchors: { line_start: 8, line_end: 12 },
    },
  ];
  const citation: Citation = {
    document_id: document.id,
    chunk_id: "chunk-1",
    snippet: "目标段落原文",
    anchors: { line_start: 9, line_end: 10 },
  };
  const jobs: Job[] = [
    {
      id: "job-1",
      document_id: document.id,
      status: "completed",
      progress: 1,
      attempts: 1,
    },
  ];
  let resolveContent!: (response: Response) => void;
  const contentResponse = new Promise<Response>((resolve) => {
    resolveContent = resolve;
  });
  const fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/documents/doc-1/content") return contentResponse;
    if (path === "/api/documents/doc-1")
      return new Response(JSON.stringify(document));
    if (path === "/api/ingestion/jobs?document_id=doc-1")
      return new Response(JSON.stringify(jobs));
    throw new Error(`未预期的请求：${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (active: boolean) => (
    <QueryClientProvider client={client}>
      <Reader
        documentId={document.id}
        citation={citation}
        reader
        active={active}
        onReader={vi.fn()}
        folders={[]}
        tags={[]}
      />
    </QueryClientProvider>
  );
  const mounted = render(view(false));
  await vi.waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/documents/doc-1/content",
      expect.any(Object),
    ),
  );
  await act(async () => {
    resolveContent(
      new Response(JSON.stringify({ text: "完整正文", sections })),
    );
    await contentResponse;
  });
  const target = await screen.findByText("目标段落原文", {
    selector: ".plain-text",
  });
  expect(scrollIntoView).not.toHaveBeenCalled();

  mounted.rerender(view(true));
  await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
  expect(scrollIntoView.mock.instances[0]).toBe(
    target.closest('[data-section-id="section-target"]'),
  );
  expect(scrollIntoView).toHaveBeenCalledWith({
    behavior: "smooth",
    block: "center",
  });

  mounted.rerender(view(false));
  expect(scrollIntoView).toHaveBeenCalledOnce();
});

it("摘要优先，属性和历史默认折叠，错误及重试统一指向任务列表", async () => {
  const document: Document = {
    id: "doc-summary",
    kb_id: "kb-1",
    folder_id: null,
    display_name: "研究正文",
    original_filename: "research.txt",
    ext: "txt",
    size_bytes: 300,
    version: 1,
    parse_status: "ready",
    index_status: "unconfigured",
    summary_status: "ready",
    classification_status: "unconfigured",
    created_at: "2026-10-23T00:00:00Z",
    short_summary: "这里是资料摘要",
    error: "敏感的详细失败原因",
    tag_ids: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.includes("/content")
              ? { text: "", sections: [] }
              : path.includes("/ingestion/jobs")
                ? [
                    {
                      id: "partial-job",
                      document_id: document.id,
                      status: "partial_ready",
                      stage: "completed",
                      progress: 100,
                      error: "需要配置模型服务；解析与关键词搜索已就绪",
                      attempts: 1,
                    },
                  ]
                : document,
          ),
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onReader = vi.fn();
  const view = (active: boolean) => (
    <QueryClientProvider client={client}>
      <Reader
        documentId={document.id}
        reader={false}
        active={active}
        onReader={onReader}
        folders={[]}
        tags={[]}
      />
    </QueryClientProvider>
  );
  const mounted = render(view(true));
  await screen.findByText("这里是资料摘要");
  const detail = screen
    .getByText("这里是资料摘要")
    .closest(".document-detail")!;
  expect(detail.firstElementChild).toHaveClass("detail-summary");
  expect(screen.getByText("文档属性").closest("details")).not.toHaveAttribute(
    "open",
  );
  expect(
    screen.getByText("处理记录 · 1 项").closest("details"),
  ).not.toHaveAttribute("open");
  expect(screen.queryByText("敏感的详细失败原因")).not.toBeInTheDocument();
  expect(
    screen.queryByText("需要配置模型服务；解析与关键词搜索已就绪"),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", {
      name: "有任务需要处理，前往任务列表查看与重试",
    }),
  ).toHaveAttribute("href", "/tasks?kb=kb-1&document=doc-summary");
  const user = userEvent.setup();
  await user.click(screen.getByText("文档属性"));
  expect(screen.getByText("知识库根目录")).toBeVisible();
  await user.click(screen.getByText("文档属性"));
  await user.click(screen.getByRole("button", { name: "文档操作" }));
  await user.click(screen.getByRole("menuitem", { name: "阅读正文" }));
  expect(onReader).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole("button", { name: "文档操作" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  mounted.rerender(view(false));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("摘要仍在生成时可直接阅读全文，待分类建议链接统一整理审阅", async () => {
  const document = {
    id: "doc-review",
    kb_id: "kb-1",
    display_name: "可检索的资料",
    original_filename: "review.txt",
    ext: "txt",
    parse_status: "ready",
    index_status: "ready",
    summary_status: "processing",
    classification_status: "ready",
    version: 3,
    size_bytes: 100,
    tag_ids: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("/content")
              ? {
                  text: "这段正文已经可以阅读",
                  sections: [
                    {
                      id: "s-1",
                      plain_text: "这段正文已经可以阅读",
                      anchors: { line_start: 1, line_end: 1 },
                    },
                  ],
                }
              : path.endsWith("/suggestion")
                ? {
                    id: "suggestion-1",
                    status: "pending",
                    document_version: 3,
                    payload: {
                      existing_tag_ids: [],
                      new_tag_names: [],
                      reason: "建议按主题归档",
                    },
                  }
                : path.includes("/ingestion/jobs")
                  ? [
                      {
                        id: "job-1",
                        document_id: document.id,
                        status: "running",
                        stage: "enriching",
                        progress: 70,
                        attempts: 1,
                      },
                    ]
                  : document,
          ),
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (reader: boolean) => (
    <QueryClientProvider client={client}>
      <Reader
        documentId={document.id}
        reader={reader}
        onReader={vi.fn()}
        folders={[]}
        tags={[]}
      />
    </QueryClientProvider>
  );
  const mounted = render(view(false));
  const link = await screen.findByRole("link", { name: "前往整理审阅" });
  expect(link).toHaveAttribute(
    "href",
    "/review?kb=kb-1&filter_kb=kb-1&document=doc-review&tab=suggestions",
  );
  mounted.rerender(view(true));
  expect(
    await screen.findByText("这段正文已经可以阅读", {
      selector: ".plain-text",
    }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "文档操作" }));
  expect(screen.getByRole("menuitem", { name: "审阅分类建议" })).toBeVisible();
  client.clear();
});
