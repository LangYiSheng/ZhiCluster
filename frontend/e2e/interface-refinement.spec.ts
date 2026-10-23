import { test, expect } from "@playwright/test";

test("精简导航、历史卡片和问答范围保留真实会话与草稿", async ({
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
    await expect(page.locator(".sidebar-tools > button").last()).toHaveText(
      "回收站",
    );
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
      [390, 844],
      [844, 390],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await page
        .getByRole("button", { name: "调整问答范围", exact: true })
        .click();
      scope = page.getByRole("dialog", { name: "问答范围", exact: true });
      const bounds = await scope.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
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
    }
    await historyButton.click();
    await page
      .getByRole("button", { name: `打开对话：${title}`, exact: true })
      .click();
    await expect(composer).toHaveValue("历史对话的独立草稿");
    expect(errors).toEqual([]);
  } finally {
    if (conversationId)
      await request.delete(`/api/conversations/${conversationId}`);
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});
