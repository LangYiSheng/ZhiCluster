import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const kb = {
  id: "compat-kb",
  name: "进度兼容资料库",
  description: "",
  version: 1,
};
const conversation = {
  id: "compat-conversation",
  kb_id: kb.id,
  title: "历史进度兼容",
  scope: { kb_ids: [kb.id] },
};
const step = (stage: string, extra: Record<string, unknown> = {}) => ({
  stage,
  label: "内部阶段",
  status: "completed",
  ...extra,
});
const messages = [
  {
    id: "compat-legacy",
    role: "assistant",
    status: "completed",
    content: "历史数值兼容回答",
    retrieval: {
      execution: [
        step("keyword", { query: "legacy-query" }),
        step("embedding", { queries: 2 }),
        step("context", { source_count: 3 }),
      ],
    },
  },
  {
    id: "compat-mixed",
    role: "assistant",
    status: "completed",
    content: "混合查询兼容回答",
    retrieval: {
      execution: [
        null,
        1,
        "invalid-entry",
        [],
        step("search", {
          round: 1,
          scope_key: "valid-scope",
          scope_label: "课程资料",
          queries: [
            "operator",
            null,
            8,
            {},
            false,
            " comparison ",
            "",
            "operator",
          ],
        }),
        step("embedding", { queries: 2 }),
        step("search_round_summary", {
          round: 1,
          scope_key: "valid-scope",
          scope_label: "课程资料",
          queries: ["operator", null, "comparison", 2, false, "operator"],
          source_count: 4,
        }),
        step("search_round_summary", {
          round: 2,
          scope_key: false,
          scope_label: { invalid: true },
          queries: 2,
          query: "fallback-query",
          source_count: 1,
        }),
      ],
    },
  },
  {
    id: "compat-invalid-container",
    role: "assistant",
    status: "completed",
    content: "无效进度容器仍保留正文",
    retrieval: { execution: { invalid: true } },
  },
];

for (const startRoute of ["chat", "review"]) {
  test(`历史queries数值及混合数组：直达${startRoute}并保留挂载聊天均正常`, async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    const unknownRequests: string[] = [];
    const mutations: string[] = [];
    let messageReads = 0;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(
      ({ kbId, id }) => {
        if (location.protocol === "http:" || location.protocol === "https:")
          localStorage.setItem(`conversation:${kbId}`, id);
      },
      { kbId: kb.id, id: conversation.id },
    );
    // Every API request uses test-owned fixtures, including when run against a daily URL.
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET") {
        mutations.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      }
      if (url.pathname === "/api/knowledge-bases")
        return route.fulfill({ json: [kb] });
      if (
        url.pathname === `/api/knowledge-bases/${kb.id}/folders` ||
        url.pathname === `/api/knowledge-bases/${kb.id}/tags`
      )
        return route.fulfill({ json: [] });
      if (url.pathname === "/api/conversations")
        return route.fulfill({ json: [conversation] });
      if (url.pathname === "/api/agent/runs")
        return route.fulfill({ json: [] });
      if (url.pathname === `/api/conversations/${conversation.id}/messages`) {
        messageReads++;
        return route.fulfill({ json: messages });
      }
      if (url.pathname === `/api/conversations/${conversation.id}/events`)
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": heartbeat\n\n",
        });
      if (url.pathname === "/api/settings/chat-models")
        return route.fulfill({
          json: { models: [], default_model: "", supports_tools: false },
        });
      if (url.pathname === "/api/review/suggestions")
        return route.fulfill({
          json: {
            items: [],
            total: 0,
            page: 1,
            page_size: 30,
            counts: { pending: 0, applied: 0, rejected: 0 },
          },
        });
      unknownRequests.push(url.pathname);
      return route.fulfill({
        status: 404,
        json: { message: "Unexpected fixture request" },
      });
    });
    const reviewPath = `/review?kb=${kb.id}&filter_kb=${kb.id}&tab=suggestions`;
    await page.goto(startRoute === "chat" ? `/chat?kb=${kb.id}` : reviewPath);
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect.poll(() => messageReads).toBeGreaterThan(0);
    if (startRoute === "review") {
      await expect(
        page.getByRole("heading", { name: "整理审阅", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".chat-view")).toHaveAttribute("hidden", "");
      await expect(page.locator(".chat-view .message-assistant")).toHaveCount(
        3,
      );
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "知识对话", exact: true })
        .click();
    }
    const legacy = page
      .locator(".message-assistant")
      .filter({ hasText: "历史数值兼容回答" });
    const mixed = page
      .locator(".message-assistant")
      .filter({ hasText: "混合查询兼容回答" });
    await expect(legacy).toBeVisible();
    await legacy.locator(".chat-progress summary").click();
    await expect(legacy.locator(".chat-search-query")).toHaveText([
      "legacy-query",
    ]);
    await expect(legacy).toContainText("已检索到 3 条信息");
    await mixed.locator(".chat-progress summary").click();
    await expect(mixed.locator(".chat-search-round")).toHaveCount(2);
    await expect(mixed.locator(".chat-search-query")).toHaveText([
      "operator",
      "comparison",
      "fallback-query",
    ]);
    await expect(mixed).toContainText("已检索到 4 条信息");
    await expect(mixed).toContainText("已检索到 1 条信息");
    await expect(
      page.getByText("无效进度容器仍保留正文", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`compat-${startRoute}-chat.png`),
      fullPage: true,
    });
    await page
      .locator(".sidebar-tools")
      .getByRole("button", { name: "整理审阅", exact: true })
      .click();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "整理审阅", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".chat-view")).toHaveAttribute("hidden", "");
    await expect(page.locator(".chat-view .message-assistant")).toHaveCount(3);
    await expect(
      page.getByText("Unexpected Application Error!", { exact: true }),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(unknownRequests).toEqual([]);
    expect(mutations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`compat-${startRoute}-review.png`),
      fullPage: true,
    });
    await writeFile(
      testInfo.outputPath("result.json"),
      JSON.stringify(
        {
          passed: true,
          startRoute,
          messageReads,
          pageErrors,
          unknownRequests,
          mutations,
          numericEmbeddingQueries: true,
          mixedQueryEntries: true,
          invalidExecutionContainer: true,
          summaryQueries: ["operator", "comparison", "fallback-query"],
          summaryCounts: [3, 4, 1],
          hiddenChatStillMounted: true,
        },
        null,
        2,
      ),
    );
  });
}
