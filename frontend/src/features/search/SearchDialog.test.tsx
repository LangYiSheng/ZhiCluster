import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchDialog } from "./SearchDialog";
import { retrievalNotice } from "./retrievalNotice";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

it("搜索结果只展示原文位置，隐藏算法与评分且仍可键盘打开来源", async () => {
  const item = {
    document_id: "d",
    chunk_id: "c",
    document_name: "政策.pdf",
    snippet: "相关政策",
    score: 0.9631,
    anchors: { page_start: 4 },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [item],
            mode: "hybrid",
            notice: "关键词 + 当前模型精确 cosine 检索，复合问题分路融合",
          }),
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const open = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SearchDialog open onOpenChange={vi.fn()} kbId="kb" onOpen={open} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "搜索关键词" }), "政策");
  expect(await screen.findByText("政策.pdf")).toBeVisible();
  expect(screen.getByText("第 4 页")).toBeVisible();
  expect(screen.queryByText(/cosine|相关度|混合检索/)).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(open).toHaveBeenCalledWith(item);
});

function searchFixture() {
  const item = {
    document_id: "source",
    chunk_id: "source-chunk",
    document_name: "旧词来源.txt",
    content: "可检查的原文证据",
    anchors: { paragraph: 1 },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items: [item] }))),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const opened = vi.fn();
  const changed = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SearchDialog open onOpenChange={changed} kbId="kb" onOpen={opened} />
    </QueryClientProvider>,
  );
  return {
    item,
    opened,
    changed,
    input: screen.getByRole("textbox", { name: "搜索关键词" }),
  };
}

it("中文输入法确认候选的Enter不会打开搜索结果或关闭弹窗", async () => {
  const { item, opened, changed, input } = searchFixture();
  fireEvent.change(input, { target: { value: "旧词" } });
  await screen.findByRole("option", { name: /旧词来源/ });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(opened).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(opened).toHaveBeenCalledWith(item);
});

it("改词后的防抖等待期间不会打开上一个关键词的来源", async () => {
  const { opened, changed, input } = searchFixture();
  fireEvent.change(input, { target: { value: "旧词" } });
  await screen.findByRole("option", { name: /旧词来源/ });
  fireEvent.change(input, { target: { value: "新词" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(opened).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});

it("结果到达前按向下键不会使首项失去键盘选择", async () => {
  const { item, opened, input } = searchFixture();
  fireEvent.change(input, { target: { value: "旧词" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const row = await screen.findByRole("option", { name: /旧词来源/ });
  expect(row).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(opened).toHaveBeenCalledWith(item);
});

it("未配置、需重建索引和服务异常提示保留，普通模式文案不显示", () => {
  expect(retrievalNotice("关键词搜索")).toBeNull();
  expect(retrievalNotice("仅关键词搜索：未配置 Embedding 服务")).toBe(
    "尚未配置向量模型，可前往设置连接。",
  );
  expect(
    retrievalNotice("仅关键词搜索：当前模型尚未向量化，请在设置中重建索引"),
  ).toBe("文档尚未建立当前模型的索引，请在设置中重建索引。");
  expect(retrievalNotice("仅关键词搜索：模型服务暂时不可用，请稍后重试")).toBe(
    "模型服务暂时不可用，请稍后重试",
  );
});

it("合并notice时只剔除常规算法文案，保留规划降级与索引操作提示", () => {
  expect(
    retrievalNotice(
      "模型检索规划暂不可用，已沿用直接检索；关键词 + 当前模型精确 cosine 检索，复合问题分路融合；仅关键词搜索：当前模型尚未向量化，请在设置中重建索引；模型未提供检索词，已使用原问题直接检索",
    ),
  ).toBe(
    "模型检索规划暂不可用，已沿用直接检索；文档尚未建立当前模型的索引，请在设置中重建索引。模型未提供检索词，已使用原问题直接检索",
  );
});
