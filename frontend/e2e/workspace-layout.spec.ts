import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForParsed } from "./helpers";

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
}

test("完整文档页、独立回收站和聊天右侧按需资料标签", async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  const response = await request.post("/api/knowledge-bases", {
    data: { name: `布局验收 ${suffix}` },
  });
  expect(response.ok()).toBeTruthy();
  const kb = (await response.json()) as { id: string };
  const names = [`侧栏资料甲-${suffix}.txt`, `侧栏资料乙-${suffix}.txt`];
  const marker = `侧栏来源定位${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`/document?kb=${kb.id}`);
    const documents = page.locator(".documents-page");
    await expect(documents).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "参考资料" }),
    ).toHaveCount(0);
    const workspaceBox = await page.locator(".workspace").boundingBox();
    const documentsBox = await documents.boundingBox();
    expect(documentsBox!.width).toBeGreaterThan(workspaceBox!.width * 0.9);
    await page.getByLabel("上传文档", { exact: true }).setInputFiles(
      names.map((name, index) => ({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from(
          `${index === 0 ? marker : `独立文本${suffix}`}\n这是第 ${index + 1} 份真实资料，用于验证阅读和引用。`,
        ),
      })),
    );
    await waitForParsed(request, kb.id, names);
    await expect(
      page.locator(".document-row").getByText("已就绪", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "知识对话", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "知识库问题" });
    await expect(composer).toBeVisible();
    const pane = page.getByRole("complementary", { name: "参考资料" });
    const activeReference = pane.getByRole("tabpanel");
    const tabs = page.getByRole("tablist", { name: "打开的资料" });
    await expect(pane).toHaveCount(0);
    await composer.fill("查看资料时保留这段草稿");
    await page.getByRole("button", { name: "浏览资料", exact: true }).click();
    await expect(pane).toBeVisible();
    await expect(tabs).toHaveCount(0);
    const chatBox = await page.locator(".chat-main").boundingBox();
    const paneBox = await pane.boundingBox();
    expect(paneBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width - 1);
    await expect(page.locator("main .reference-pane")).toHaveCount(0);
    const mainBox = await page.locator("main").boundingBox();
    expect(paneBox!.y).toBe(mainBox!.y);
    expect(paneBox!.height).toBe(mainBox!.height);
    await expect(pane.locator(".reference-pane-heading")).toHaveCount(0);

    async function openReader(name: string) {
      const row = pane.locator(".document-row").filter({ hasText: name });
      await row.locator(".document-open").click();
    }

    await openReader(names[0]);
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(
      tabs.getByRole("tab", { name: names[0], exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(activeReference.locator(".text-reader")).toContainText(marker);
    await expect(page).toHaveURL(new RegExp(`/chat\\?kb=${kb.id}$`));
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog").getByLabel("搜索关键词").fill(marker);
    await expect(page.getByRole("option").first()).toContainText(names[0]);
    await page.getByRole("option").first().click();
    await expect(activeReference.locator(".citation-banner")).toContainText(
      "行",
    );
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(page).toHaveURL(new RegExp(`/chat\\?kb=${kb.id}$`));
    await expect(composer).toHaveValue("查看资料时保留这段草稿");
    await tabs.getByRole("tab", { name: "资料管理", exact: true }).click();
    await openReader(names[1]);
    await expect(tabs.getByRole("tab")).toHaveCount(3);
    await expect(activeReference.locator(".text-reader")).toContainText(
      `独立文本${suffix}`,
    );
    await pane
      .getByRole("button", { name: `关闭 ${names[0]}`, exact: true })
      .click();
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await pane
      .getByRole("button", { name: "关闭 资料管理", exact: true })
      .click();
    await expect(tabs).toHaveCount(0);
    await expect(activeReference.locator(".text-reader")).toContainText(
      `独立文本${suffix}`,
    );
    await page
      .getByRole("button", { name: "关闭参考资料", exact: true })
      .click();
    await expect(pane).toHaveCount(0);

    for (const [width, height] of [
      [1440, 900],
      [1100, 800],
      [390, 844],
      [844, 390],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await page.getByRole("button", { name: "浏览资料", exact: true }).click();
      await expect(pane).toBeVisible();
      await expect(tabs).toHaveCount(0);
      const bounds = await pane.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      await expectNoOverflow(page);
      if (width <= 780) {
        const closeReference = pane.getByRole("button", {
          name: "关闭参考资料",
          exact: true,
        });
        await expect(closeReference).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(closeReference).toBeFocused();
      }
      await page.screenshot({
        path: `test-results/workspace-reference-${width}x${height}.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "关闭参考资料", exact: true })
        .click();
      await expect(composer).toBeVisible();
      if (width <= 780)
        await expect(
          page.getByRole("button", { name: "浏览资料", exact: true }),
        ).toBeFocused();
      await expectNoOverflow(page);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    const trash = page.getByRole("button", { name: "回收站", exact: true });
    const settings = page.getByRole("button", { name: "设置", exact: true });
    expect((await trash.boundingBox())!.y).toBeLessThan(
      (await settings.boundingBox())!.y,
    );
    await trash.click();
    await expect(page).toHaveURL(new RegExp(`/trash\\?kb=${kb.id}$`));
    await expect(page.locator(".documents-page")).toBeVisible();
    await expect(pane).toHaveCount(0);
    await expect(composer).toHaveCount(0);
    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await expectNoOverflow(page);
      await page.screenshot({
        path: `test-results/workspace-trash-${width}x${height}.png`,
        fullPage: true,
      });
    }
    await page.goto(`/agent?kb=${kb.id}`);
    await expect(page).toHaveURL(new RegExp(`/chat\\?kb=${kb.id}$`));
    await expect(composer).toBeVisible();
    await expect(page.getByRole("button", { name: "智能整理" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});
