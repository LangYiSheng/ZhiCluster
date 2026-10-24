import { test, expect } from "@playwright/test";
import { waitForParsed } from "./helpers";

test("真实资料弹窗关闭还焦、删除来源回到工作区、移动端搜索保留资料焦点", async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  const kbName = `焦点验收 ${suffix}`;
  const response = await request.post("/api/knowledge-bases", {
    data: { name: kbName },
  });
  expect(response.ok()).toBeTruthy();
  const kb = (await response.json()) as { id: string };
  const filename = `焦点资料-${suffix}.txt`;
  const marker = `来源焦点${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`/document?kb=${kb.id}`);
    const create = page.getByRole("button", {
      name: "新建文件夹",
      exact: true,
    });
    await create.click();
    await expect(
      page.getByRole("dialog").getByLabel("名称", { exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(create).toBeFocused();

    await page.getByLabel("上传文档", { exact: true }).setInputFiles({
      name: filename,
      mimeType: "text/plain",
      buffer: Buffer.from(`${marker}：公开测试资料，检查真实组件的焦点归属。`),
    });
    await waitForParsed(request, kb.id, [filename]);
    const row = page.locator(".document-row").filter({ hasText: filename });
    const menuButton = row.getByRole("button", {
      name: `${filename}文档菜单`,
      exact: true,
    });
    await menuButton.click();
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByLabel("名称", { exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menuButton).toBeFocused();

    const documentButton = row.locator(".document-open");
    await documentButton.focus();
    await documentButton.press("Shift+F10");
    await page.getByRole("menuitem", { name: "重命名", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog").getByLabel("名称", { exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(documentButton).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "知识对话", exact: true }).click();
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog").getByLabel("搜索关键词").fill(marker);
    await expect(page.getByRole("option").first()).toContainText(filename);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const reference = page.getByRole("complementary", {
      name: "参考资料",
      exact: true,
    });
    await expect(reference).toBeVisible();
    await expect(reference.locator(".reference-close")).toBeFocused();
    await expect(reference.locator(".text-reader")).toContainText(marker);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/document?kb=${kb.id}`);
    await documentButton.focus();
    await documentButton.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "移到回收站", exact: true })
      .click();
    const confirmation = page.getByRole("dialog");
    await confirmation
      .getByRole("button", { name: "确认移到回收站", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    await expect(confirmation).toHaveCount(0);
    await expect(page.locator("main.workspace")).toBeFocused();
    const expand = page.getByRole("button", {
      name: "展开左侧导航",
      exact: true,
    });
    if (await expand.isVisible()) await expand.click();
    await page
      .getByRole("button", { name: `${kbName}菜单`, exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "删除知识库", exact: true })
      .click();
    const deleteLibrary = page.getByRole("dialog", {
      name: "确认删除",
      exact: true,
    });
    await deleteLibrary
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: kbName, exact: true }),
    ).toHaveCount(0);
    await expect(deleteLibrary).toHaveCount(0);
    await expect(page.locator(".library-slot")).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await request
      .delete(`/api/knowledge-bases/${kb.id}`)
      .catch(() => undefined);
  }
});
