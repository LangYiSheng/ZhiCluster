import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

async function expectAnchored(page: Page, trigger: Locator, panel: Locator) {
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".dialog-overlay:visible")).toHaveCount(0);
  const [button, card] = await Promise.all([
    trigger.boundingBox(),
    panel.boundingBox(),
  ]);
  const viewport = page.viewportSize()!;
  expect(card!.x).toBeGreaterThanOrEqual(0);
  expect(card!.y).toBeGreaterThanOrEqual(0);
  expect(card!.x + card!.width).toBeLessThanOrEqual(viewport.width);
  expect(card!.y + card!.height).toBeLessThanOrEqual(viewport.height);
  expect(card!.width).toBeLessThanOrEqual(410);
  expect(card!.height).toBeLessThanOrEqual(560);
  const verticalGap = Math.min(
    Math.abs(card!.y - (button!.y + button!.height)),
    Math.abs(button!.y - (card!.y + card!.height)),
  );
  expect(verticalGap).toBeLessThanOrEqual(16);
}

test("按钮旁的非模态历史与范围卡片，保持会话、草稿和路由切换", async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  const kbResponse = await request.post("/api/knowledge-bases", {
    data: { name: `交互验收 ${suffix}` },
  });
  expect(kbResponse.ok()).toBeTruthy();
  const kb = (await kbResponse.json()) as { id: string; name: string };
  const title = `历史资料讨论 ${suffix}`;
  let conversationId = "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const folderResponse = await request.post(
      `/api/knowledge-bases/${kb.id}/folders`,
      {
        data: { name: "研究范围" },
      },
    );
    expect(folderResponse.ok()).toBeTruthy();
    const folder = (await folderResponse.json()) as { id: string };
    const tagResponse = await request.post(
      `/api/knowledge-bases/${kb.id}/tags`,
      {
        data: { name: "范围标签", color: "#3f6b50", aliases: [] },
      },
    );
    expect(tagResponse.ok()).toBeTruthy();
    const tag = (await tagResponse.json()) as { id: string };
    const conversationResponse = await request.post("/api/conversations", {
      data: {
        title,
        scope: { kb_ids: [kb.id], folder_ids: [folder.id], tag_ids: [tag.id] },
      },
    });
    expect(conversationResponse.ok()).toBeTruthy();
    conversationId = ((await conversationResponse.json()) as { id: string }).id;

    await page.goto(`/chat?kb=${kb.id}`);
    const composer = page.getByRole("textbox", { name: "知识库问题" });
    await composer.fill("新对话尚未发送的草稿");
    await expect(
      page.locator(
        ".workspace-footer, .conversation-toolbar, .quick-search, .library-bottom, .tag-list, .private-indicator",
      ),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "切换主题" })).toHaveCount(0);
    await expect(page.locator(".sidebar-tools > button")).toHaveText([
      "回收站",
      "设置",
    ]);
    await expect(page.getByRole("button", { name: "智能整理" })).toHaveCount(0);
    const historyButton = page.getByRole("button", {
      name: "历史对话",
      exact: true,
    });
    const historyBounds = await historyButton.boundingBox();
    const searchBounds = await page
      .getByRole("button", { name: "搜索知识", exact: true })
      .boundingBox();
    expect(historyBounds!.x).toBeLessThan(searchBounds!.x);

    await historyButton.click();
    const history = page.getByRole("dialog", {
      name: "历史对话",
      exact: true,
    });
    await expectAnchored(page, historyButton, history);
    await expect(historyButton).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: `打开对话：${title}`, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await composer.fill("历史对话的独立草稿");
    await page
      .getByRole("button", { name: "调整问答范围", exact: true })
      .click();
    let scope = page.getByRole("dialog", { name: "问答范围", exact: true });
    await expectAnchored(
      page,
      page.getByRole("button", { name: "调整问答范围", exact: true }),
      scope,
    );
    await expect(
      scope.getByRole("checkbox", { name: "研究范围", exact: true }),
    ).toBeChecked();
    await expect(
      scope.getByRole("checkbox", { name: "范围标签", exact: true }),
    ).toBeChecked();
    await expect(
      scope.getByRole("checkbox", { name: "范围标签", exact: true }),
    ).toBeDisabled();
    await scope.getByRole("button", { name: "关闭范围", exact: true }).click();

    await historyButton.click();
    await expect(
      page.getByRole("button", { name: `打开对话：${title}`, exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(composer).toHaveValue("新对话尚未发送的草稿");

    for (const [width, height] of [
      [1440, 900],
      [1100, 800],
      [390, 844],
      [844, 390],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await page
        .getByRole("button", { name: "调整问答范围", exact: true })
        .click();
      scope = page.getByRole("dialog", { name: "问答范围", exact: true });
      await expectAnchored(
        page,
        page.getByRole("button", { name: "调整问答范围", exact: true }),
        scope,
      );
      await scope
        .getByRole("checkbox", { name: "研究范围", exact: true })
        .check();
      await scope
        .getByRole("checkbox", { name: "范围标签", exact: true })
        .check();
      await scope.getByRole("button", { name: "完成", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "调整问答范围", exact: true }),
      ).toContainText("1 个文件夹");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      await historyButton.click();
      await expectAnchored(page, historyButton, history);
      await page.keyboard.press("Escape");
      await expect(history).toHaveCount(0);
    }
    await historyButton.click();
    await page
      .getByRole("button", { name: `打开对话：${title}`, exact: true })
      .click();
    await expect(composer).toHaveValue("历史对话的独立草稿");

    await page.setViewportSize({ width: 1440, height: 900 });
    await historyButton.click();
    await composer.click();
    await expect(history).toHaveCount(0);
    await historyButton.click();
    await page
      .getByRole("button", { name: "调整问答范围", exact: true })
      .click();
    await expect(history).toHaveCount(0);
    await expect(scope).toBeVisible();
    await historyButton.click();
    await expect(scope).toHaveCount(0);
    await expect(history).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "文档管理", exact: true }).click();
    await page.getByRole("button", { name: "知识对话", exact: true }).click();
    await historyButton.click();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/document\\?kb=${kb.id}$`));
    await expect(history).toHaveCount(0);
    await page.goForward();
    await expect(composer).toBeVisible();
    await expect(history).toHaveCount(0);
    await page
      .getByRole("button", { name: "调整问答范围", exact: true })
      .click();
    await page.goBack();
    await expect(scope).toHaveCount(0);
    await page.goForward();
    await expect(composer).toBeVisible();
    await expect(scope).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (conversationId)
      await request.delete(`/api/conversations/${conversationId}`);
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});
