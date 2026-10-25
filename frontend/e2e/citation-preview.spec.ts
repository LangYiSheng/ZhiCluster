import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const kb = {
  id: "preview-kb",
  name: "预览验收知识库",
  description: "只读页面样例",
  version: 1,
};
const title = `超长文件名_${"研究方法与阅读记录".repeat(12)}.txt`;
const snippet = `预览片段：${"这里是被引用资料中的事实与上下文。".repeat(20)}`;
const privateValues = [
  "PRIVATE_DOCUMENT_NAME_SENTINEL",
  "PRIVATE_SNIPPET_SENTINEL",
  "PRIVATE_LIBRARY_SENTINEL",
];
const sourceDocument = {
  id: "preview-document",
  kb_id: kb.id,
  folder_id: null,
  display_name: title,
  original_filename: title,
  ext: "txt",
  preview_type: "text",
  size_bytes: 256,
  version: 1,
  parse_status: "ready",
  index_status: "ready",
  summary_status: "ready",
  classification_status: "unconfigured",
  short_summary: "只读测试的正文摘要。",
  created_at: "2026-10-25T00:00:00Z",
  tag_ids: [],
};
const content = {
  text: snippet,
  sections: [
    {
      id: "intro",
      heading: "引言",
      plain_text: "开头段落",
      order: 1,
      anchors: { paragraph_start: 1 },
    },
    {
      id: "citation-target",
      heading: "来源目标段落",
      plain_text: snippet,
      order: 2,
      anchors: { paragraph_start: 2 },
    },
  ],
};

async function installFixtures(page: Page) {
  const mutations: string[] = [];
  const documentReads: string[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ kbId }) => {
      localStorage.setItem("zhicluster-kb", kbId);
      localStorage.setItem(`conversation:${kbId}`, "preview-conversation");
      const state = window as unknown as { __citationClicks: number };
      state.__citationClicks = 0;
      document.addEventListener(
        "click",
        (event) => {
          if ((event.target as Element).closest(".citation-marker"))
            state.__citationClicks++;
        },
        true,
      );
    },
    { kbId: kb.id },
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(4);
    if (!["GET", "HEAD"].includes(request.method())) {
      mutations.push(`${request.method()} ${path}`);
      await route.abort();
      return;
    }
    const reply = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith("/events")) {
      await route.fulfill({
        contentType: "text/event-stream",
        body: ": fixture\n\n",
      });
      return;
    }
    if (path === "/knowledge-bases") return reply([kb]);
    if (
      path === `/knowledge-bases/${kb.id}/folders` ||
      path === `/knowledge-bases/${kb.id}/tags`
    )
      return reply([]);
    if (path === `/knowledge-bases/${kb.id}/documents`)
      return reply({ items: [sourceDocument], total: 1, page: 1, page_size: 50 });
    if (path === "/settings/chat-models")
      return reply({ models: [], default_model: "", configured: false });
    if (path === "/settings/file-formats")
      return reply({
        formats: [
          {
            extension: "txt",
            label: "TXT",
            mime_type: "text/plain",
            preview: "text",
            available: true,
          },
        ],
      });
    if (path === "/conversations")
      return reply([
        {
          id: "preview-conversation",
          kb_id: kb.id,
          title: "来源卡片验收",
          scope: { kb_ids: [kb.id], tag_ids: [], folder_ids: [] },
        },
      ]);
    if (path === "/conversations/preview-conversation/messages")
      return reply([
        {
          id: "preview-user",
          role: "user",
          content: "查阅资料",
          status: "completed",
          citations: [],
        },
        {
          id: "preview-assistant",
          role: "assistant",
          content: "可悬停查看资料[S1]，这个旧来源已不可用[S2]。",
          status: "completed",
          citations: [
            {
              ordinal: 1,
              available: true,
              document_id: sourceDocument.id,
              chunk_id: "preview-chunk",
              document_name: title,
              ext: "txt",
              kb_id: kb.id,
              kb_name: kb.name,
              snippet,
              anchors: { paragraph_start: 2 },
            },
            {
              ordinal: 2,
              available: false,
              document_id: "unavailable-document",
              chunk_id: "private-chunk",
              document_name: privateValues[0],
              display_name: privateValues[0],
              snippet: privateValues[1],
              kb_name: privateValues[2],
              ext: "pdf",
              anchors: { page_start: 99 },
            },
          ],
        },
      ]);
    if (path === `/documents/${sourceDocument.id}`) {
      documentReads.push(path);
      return reply(sourceDocument);
    }
    if (path === `/documents/${sourceDocument.id}/content`) return reply(content);
    if (path === "/ingestion/jobs") return reply([]);
    if (path === "/ingestion/jobs/page")
      return reply({ items: [], total: 0, page: 1, page_size: 1, counts: {} });
    unexpected.push(path);
    await route.fulfill({
      status: 404,
      json: { code: "fixture_not_found", message: "只读页面样例未定义此接口" },
    });
  });
  return { mutations, documentReads, unexpected, errors };
}

const inlineSource = (page: Page) =>
  page.getByRole("button", { name: `查看来源 1：${title}`, exact: true });
const preview = (page: Page) =>
  page.getByRole("tooltip", { name: `来源预览：${title}`, exact: true });

test("来源卡片：鼠标跨入、键盘关闭、保密、原阅读器与根目录菜单", async ({
  page,
}, testInfo) => {
  const state = await installFixtures(page);
  await page.goto(`/chat?kb=${kb.id}`);
  const source = inlineSource(page);
  await expect(source).toBeVisible();
  await expect(source).not.toHaveAttribute("title");
  await source.hover();
  const card = preview(page);
  await expect(card).toBeVisible();
  await expect(card.locator(".citation-preview-title")).toHaveText(title);
  await expect(card.locator(".citation-preview-snippet")).toHaveText(snippet);
  await expect(card.locator(".citation-preview-format")).toHaveText("TXT");
  await expect(card.locator(".citation-preview-library")).toHaveText(
    `@ ${kb.name}`,
  );
  expect(state.documentReads).toEqual([]);
  await card.hover();
  await page.waitForTimeout(350);
  await expect(card).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-hover.png"),
    fullPage: true,
  });
  await page.getByRole("textbox", { name: "知识库问题", exact: true }).hover();
  await expect(card).toBeHidden();

  // Reach the inline citation through actual keyboard navigation.
  await page.getByRole("textbox", { name: "知识库问题", exact: true }).focus();
  for (
    let step = 0;
    step < 30 &&
    !(await source.evaluate((element) => element === document.activeElement));
    step++
  )
    await page.keyboard.press("Shift+Tab");
  await expect(source).toBeFocused();
  await expect(card).toBeVisible();
  await expect(source).toBeFocused();
  expect(await source.getAttribute("aria-describedby")).toBe(
    await card.getAttribute("id"),
  );
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await page.waitForTimeout(350);
  await expect(card).toBeHidden();
  await expect(source).toBeFocused();

  const unavailable = page.getByRole("button", {
    name: "引用 2 不可用",
    exact: true,
  });
  await expect(unavailable).toBeDisabled();
  await unavailable.hover({ force: true });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "来源不可用 2", exact: true }),
  ).toBeDisabled();
  const html = await page.locator("body").innerHTML();
  for (const value of privateValues) expect(html).not.toContain(value);
  expect(state.documentReads).toEqual([]);

  await source.click();
  await expect(
    page.locator(
      '.reference-pane .text-section.highlighted[data-section-id="citation-target"]',
    ),
  ).toContainText("预览片段");
  await expect(page.locator(".reference-pane .text-reader")).toBeVisible();
  await expect(card).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __citationClicks: number }).__citationClicks,
    ),
  ).toBe(1);

  await page.goto(`/document?kb=${kb.id}`);
  const pane = page.locator(".documents-pane:visible").first();
  await expect(
    pane.getByRole("button", { name: "知识库根目录", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await pane.getByRole("button", { name: "知识库操作", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "编辑知识库",
    "刷新文件",
    "管理标签",
  ]);
  await expect(
    page.getByRole("menuitem", { name: "未分类", exact: true }),
  ).toHaveCount(0);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  await writeFile(
    testInfo.outputPath("desktop-evidence.json"),
    JSON.stringify(state, null, 2),
  );
});

test("390像素长文件名预览卡完整留在屏幕内", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await installFixtures(page);
  await page.goto(`/chat?kb=${kb.id}`);
  await inlineSource(page).hover();
  const card = preview(page);
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(box.width).toBeLessThanOrEqual(366);
  const titleBox = (await card
    .locator(".citation-preview-title")
    .boundingBox())!;
  expect(titleBox.height).toBeLessThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("narrow-hover.png"),
    fullPage: true,
  });
  expect(state.mutations).toEqual([]);
  expect(state.documentReads).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  await writeFile(
    testInfo.outputPath("narrow-evidence.json"),
    JSON.stringify({ ...state, box, titleBox }, null, 2),
  );
});

test.describe("真实触屏事件", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  test("单次轻点打开一次原阅读器，无残留悬停卡", async ({ page }, testInfo) => {
    const state = await installFixtures(page);
    await page.goto(`/chat?kb=${kb.id}`);
    await inlineSource(page).tap();
    await expect(
      page.locator(
        '.reference-pane .text-section.highlighted[data-section-id="citation-target"]',
      ),
    ).toContainText("预览片段");
    await expect(page.locator(".reference-pane .text-reader")).toBeVisible();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __citationClicks: number }).__citationClicks,
      ),
    ).toBe(1);
    expect(state.documentReads.length).toBeGreaterThanOrEqual(1);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("touch-reader.png"),
      fullPage: true,
    });
    await writeFile(
      testInfo.outputPath("touch-evidence.json"),
      JSON.stringify({ ...state, nativeClicks: 1 }, null, 2),
    );
  });
});
