import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, anchorText, items, query } from "./api";
afterEach(() => vi.unstubAllGlobals());
describe("真实API客户端边界", () => {
  it("上传FormData不覆盖multipart boundary", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    vi.stubGlobal("fetch", fetcher);
    const body = new FormData();
    body.append("files", new File(["正文"], "文档.md"));
    await api("/uploads", { method: "POST", body });
    expect(
      (fetcher.mock.calls[0][1].headers as Headers).has("Content-Type"),
    ).toBe(false);
  });
  it("解析标准错误并保留请求id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "cross_kb",
              message: "目标属于其他知识库",
              request_id: "req-1",
            },
          }),
          { status: 403 },
        ),
      ),
    );
    try {
      await api("/documents");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("cross_kb");
      expect((e as ApiError).requestId).toBe("req-1");
      return;
    }
    throw new Error("应拒绝跨库请求");
  });
  it("锚点忠实区分PDF页与DOCX段落", () => {
    expect(
      anchorText({
        document_id: "d",
        chunk_id: "c",
        anchors: { page_start: 3 },
      }),
    ).toBe("第 3 页");
    expect(
      anchorText({
        document_id: "d",
        chunk_id: "c",
        anchors: { paragraph_start: 9 },
      }),
    ).toBe("第 9 段");
    expect(
      anchorText({
        document_id: "d",
        chunk_id: "c",
        anchors: { line_start: 4 },
      }),
    ).toBe("第 4 行");
  });
  it("安全编码过滤值并保留false与0", () => {
    expect(
      query({ folder: "中文 & folder", trash: false, page: 0, empty: "" }),
    ).toBe("?folder=%E4%B8%AD%E6%96%87+%26+folder&trash=false&page=0");
    expect(items({ items: [1, 2] })).toEqual([1, 2]);
  });
});
