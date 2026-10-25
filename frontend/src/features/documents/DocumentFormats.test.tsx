import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DocumentsPane } from "./DocumentsPane";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
const extensions = [
  "pdf",
  "docx",
  "md",
  "txt",
  "pptx",
  "xlsx",
  "csv",
  "html",
  "htm",
  "json",
  "jsonl",
  "doc",
  "xls",
  "ppt",
  "epub",
];
const kb = { id: "formats", name: "格式库", description: "", version: 1 };
it("上传与搜索都采用服务端格式目录，依赖不可用的格式显示原因", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      const data = path.endsWith("/settings/file-formats")
        ? {
            formats: extensions.map((extension) => ({
              extension,
              label: extension.toUpperCase(),
              mime_type: "text/plain",
              preview: extension === "pdf" ? "pdf" : "text",
              available: extension !== "doc",
              reason: extension === "doc" ? "旧版文档转换组件尚未安装" : null,
            })),
          }
        : path.includes("/documents")
          ? { items: [], total: 0, page_size: 50 }
          : [];
      return new Response(JSON.stringify(data));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DocumentsPane
          kb={kb}
          folders={[]}
          tags={[]}
          trash={false}
          selectedId=""
          onOpen={vi.fn()}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await vi.waitFor(() =>
    expect(screen.getByLabelText("上传文档")).toHaveAttribute(
      "accept",
      extensions
        .filter((extension) => extension !== "doc")
        .map((extension) => `.${extension}`)
        .join(","),
    ),
  );
  await userEvent.click(screen.getByText("部分格式暂不可用：DOC"));
  expect(screen.getByText("DOC · 旧版文档转换组件尚未安装")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "搜索知识库资料" }));
  await userEvent.click(screen.getByRole("combobox", { name: "文件类型筛选" }));
  expect(
    screen.getByRole("option", { name: "EPUB" }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("option", { name: "PPTX" }),
  );
  await vi.waitFor(() =>
    expect(paths.some((path) => path.includes("ext=pptx"))).toBe(true),
  );
});
