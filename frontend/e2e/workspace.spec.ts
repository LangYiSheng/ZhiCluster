import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
test("真实后端：知识管理、入库、中文搜索、回收恢复与响应式主题", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString();
  const name = `浏览器验收 ${suffix}`;
  const kbResponse = await request.post("/api/knowledge-bases", {
    data: { name, description: "Playwright真实API验收" },
  });
  expect(kbResponse.ok()).toBeTruthy();
  const kb = (await kbResponse.json()) as { id: string };
  const filename = `知识验收-${suffix}.md`;
  const marker = `可追溯知识${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`/document?kb=${kb.id}`);
    await expect(page.locator(".documents-page")).toBeVisible();
    await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("名称", { exact: true })
      .fill("研究资料");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "研究资料", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "管理标签", exact: true }).click();
    await page.getByRole("button", { name: "新建标签", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("名称", { exact: true })
      .fill("检索研究");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "管理标签" })).toContainText(
      "检索研究",
    );
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByLabel("上传文档", { exact: true }).setInputFiles({
      name: filename,
      mimeType: "text/markdown",
      buffer: Buffer.from(
        `# 真实知识验收\n\n${marker}：知识簇保存原始文档、章节和来源行号。\n\n## 研究方法\n基于真实文件的中文关键词检索。\n\n<script>window.__zcXss=1</script>\n\n[bad](javascript:window.__zcXss=2)`,
      ),
    });
    const row = page.locator(".document-row").filter({ hasText: filename });
    await expect(row).toBeVisible();
    await expect(row.getByText("已就绪", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await row
      .getByRole("button", { name: new RegExp(filename) })
      .first()
      .click();
    await expect(page).toHaveURL(/\/document\?.*document=/);
    await expect(page.locator(".reader-toolbar")).toContainText(filename);
    await expect(page.locator(".text-reader")).toContainText(marker);
    expect(
      await page.evaluate(
        () => (window as Window & { __zcXss?: number }).__zcXss,
      ),
    ).toBeUndefined();
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await page.goto(`/document?kb=${kb.id}`);
    await row
      .getByRole("button", { name: `${filename}文档菜单`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "设置标签", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("检索研究", { exact: true })
      .check();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.locator(".dialog-content")).toHaveCount(0);
    await row
      .getByRole("button", { name: `${filename}文档菜单`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "移动到…", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("目标文件夹")
      .selectOption({ label: "研究资料" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog").getByLabel("搜索关键词").fill(marker);
    await expect(page.getByRole("option").first()).toContainText(filename);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator(".citation-banner")).toContainText("行");
    await expect(page.locator(".text-reader")).toContainText(marker);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("显示模式", { exact: true }).selectOption("dark");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: "test-results/workspace-dark-1440.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("显示模式", { exact: true }).selectOption("light");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await page.screenshot({
      path: "test-results/workspace-light-1440.png",
      fullPage: true,
    });
    await page.goto(`/document?kb=${kb.id}`);
    await row.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "移到回收站", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "移到回收站", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认移到回收站" })
      .click();
    await expect(row).toHaveCount(0);
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/trash\\?kb=${kb.id}$`));
    await expect(page.locator(".documents-page")).toBeVisible();
    const deletedBases = page.locator(".deleted-kbs");
    if (await deletedBases.count()) {
      await expect(deletedBases).not.toHaveAttribute("open");
      await deletedBases.locator("summary").click();
      const list = await page.locator(".deleted-kb-list").boundingBox();
      expect(list!.height).toBeLessThanOrEqual(160);
      await deletedBases.locator("summary").click();
    }
    const trashed = page.locator(".document-row").filter({ hasText: filename });
    await expect(trashed).toBeVisible();
    await trashed
      .getByRole("button", { name: `${filename}文档菜单`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "恢复文档", exact: true }).click();
    await expect(trashed).toHaveCount(0);
    await page.goto(`/document?kb=${kb.id}`);
    await expect(
      page.locator(".document-row").filter({ hasText: filename }),
    ).toBeVisible();
    await page.setViewportSize({ width: 900, height: 780 });
    await page.screenshot({
      path: "test-results/workspace-tablet-900.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/chat?kb=${kb.id}`);
    await page
      .getByRole("button", { name: "展开知识库栏", exact: true })
      .click();
    await page.getByRole("button", { name: "知识对话", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "让知识产生连接" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/workspace-mobile-390.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await page
      .getByRole("button", { name: "展开知识库栏", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "新建知识库", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "外观与布局" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "模型连接", exact: true }).click();
    await expect(
      page
        .getByRole("region", { name: "聊天模型", exact: true })
        .getByLabel("服务地址", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await request
      .delete(`/api/knowledge-bases/${kb.id}`)
      .catch(() => undefined);
  }
});
test("真实PDF页码与DOCX段落来源定位", async ({ page, request }) => {
  const response = await request.post("/api/knowledge-bases", {
    data: { name: `来源定位验收 ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const kb = (await response.json()) as { id: string };
  try {
    await page.goto(`/chat?kb=${kb.id}`);
    const reference = page
      .getByRole("complementary", { name: "参考资料" })
      .getByRole("tabpanel");
    await page.getByRole("button", { name: "浏览资料", exact: true }).click();
    await page
      .getByLabel("上传文档", { exact: true })
      .setInputFiles([
        resolve(import.meta.dirname, "fixtures/anchors.pdf"),
        resolve(import.meta.dirname, "fixtures/anchors.docx"),
      ]);
    for (const file of ["anchors.pdf", "anchors.docx"])
      await expect(
        page
          .locator(".document-row")
          .filter({ hasText: file })
          .getByText("已就绪", { exact: true }),
      ).toBeVisible({ timeout: 30000 });
    await page.keyboard.press("Control+k");
    await page
      .getByRole("dialog")
      .getByLabel("搜索关键词")
      .fill("PositionCheckPDF");
    await expect(page.getByRole("option").first()).toContainText("第 2 页");
    await page.getByRole("option").first().click();
    await expect(reference.locator(".pdf-canvas")).toHaveAttribute(
      "data-rendered-page",
      "2",
    );
    await expect(reference.locator('[data-pdf-text="2"]')).toContainText(
      "PositionCheckPDF",
    );
    expect(
      await reference.locator(".pdf-canvas").evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] < 150 &&
            pixels[i + 1] < 150 &&
            pixels[i + 2] < 150 &&
            pixels[i + 3] > 0
          )
            ink++;
        return ink > 10;
      }),
    ).toBeTruthy();
    await expect(reference.locator(".citation-banner")).toContainText(
      "第 2 页",
    );
    await expect(page).toHaveURL(new RegExp(`/chat\\?kb=${kb.id}$`));
    const downloadUrl = await reference
      .locator(".reader-toolbar>a")
      .getAttribute("href");
    const download = await request.get(`${downloadUrl}?inline=true`);
    expect(download.headers()["content-disposition"]).toContain("inline");
    expect(download.headers()["content-type"]).toContain("application/pdf");
    await page.screenshot({
      path: "test-results/pdf-source-page-2.png",
      fullPage: true,
    });
    await page.keyboard.press("Control+k");
    await page
      .getByRole("dialog")
      .getByLabel("搜索关键词")
      .fill("PositionCheckDOCX");
    await expect(page.getByRole("option").first()).toContainText("段");
    await page.getByRole("option").first().click();
    await expect(reference.locator(".citation-banner")).toContainText("段");
    await expect(reference.locator(".pdf-canvas")).toHaveCount(0);
    await expect(reference.locator(".text-reader")).toContainText(
      "PositionCheckDOCX",
    );
    await page.screenshot({
      path: "test-results/docx-source-paragraph.png",
      fullPage: true,
    });
  } finally {
    await request
      .delete(`/api/knowledge-bases/${kb.id}`)
      .catch(() => undefined);
  }
});

test("真实拖放上传、复选批量标签与移动、文件夹子树循环拒绝、筛选排序", async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  const response = await request.post("/api/knowledge-bases", {
    data: { name: `拖放批量验收 ${suffix}` },
  });
  expect(response.ok()).toBeTruthy();
  const kb = (await response.json()) as { id: string };
  const filenames = [`A-拖放资料-${suffix}.txt`, `B-拖放资料-${suffix}.txt`];
  try {
    await page.goto(`/document?kb=${kb.id}`);
    await expect(page.locator(".documents-page")).toBeVisible();
    for (const name of ["资料归档", "研究主题"]) {
      await page
        .getByRole("button", { name: "新建文件夹", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByLabel("名称", { exact: true })
        .fill(name);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole("button", { name: "研究主题文件夹菜单", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "新建子文件夹", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("名称", { exact: true })
      .fill("子主题");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "子主题", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "管理标签", exact: true }).click();
    await page.getByRole("button", { name: "新建标签", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("名称", { exact: true })
      .fill("批量验收");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "管理标签" })).toContainText(
      "批量验收",
    );
    await page.getByRole("button", { name: "完成", exact: true }).click();
    const transfer = await page.evaluateHandle((names) => {
      const data = new DataTransfer();
      names.forEach((name, index) =>
        data.items.add(
          new File([`真实系统拖入文件 ${index + 1}，批量管理验收。`], name, {
            type: "text/plain",
          }),
        ),
      );
      return data;
    }, filenames);
    const uploadResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/knowledge-bases/${kb.id}/uploads`) &&
        r.request().method() === "POST",
    );
    await page
      .locator(".documents-pane")
      .dispatchEvent("dragover", { dataTransfer: transfer });
    await page
      .locator(".documents-pane")
      .dispatchEvent("drop", { dataTransfer: transfer });
    expect((await uploadResponse).ok()).toBeTruthy();
    await transfer.dispose();
    await page.locator(".upload-results > summary").click();
    for (const name of filenames) {
      const row = page.locator(".document-row").filter({ hasText: name });
      await expect(row.getByText("已就绪", { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await row
        .getByRole("checkbox", { name: `选择 ${name}`, exact: true })
        .check();
    }
    await page.getByRole("button", { name: "批量操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "批量标签", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("批量验收", { exact: true })
      .check();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.locator(".dialog-content")).toHaveCount(0);
    for (const name of filenames)
      await page
        .getByRole("checkbox", { name: `选择 ${name}`, exact: true })
        .check();
    await page
      .locator(".document-row")
      .filter({ hasText: filenames[0] })
      .dragTo(
        page
          .getByRole("button", { name: "研究主题", exact: true })
          .locator(".."),
      );
    const folders = (await (
      await request.get(`/api/knowledge-bases/${kb.id}/folders`)
    ).json()) as { id: string; name: string; parent_id: string | null }[];
    const topic = folders.find((f) => f.name === "研究主题")!;
    const archive = folders.find((f) => f.name === "资料归档")!;
    const child = folders.find((f) => f.name === "子主题")!;
    const tags = (await (
      await request.get(`/api/knowledge-bases/${kb.id}/tags`)
    ).json()) as { id: string; name: string }[];
    const tag = tags.find((t) => t.name === "批量验收")!;
    await expect
      .poll(async () => {
        const result = (await (
          await request.get(`/api/knowledge-bases/${kb.id}/documents`)
        ).json()) as {
          items: {
            display_name: string;
            folder_id: string | null;
            tag_ids: string[];
          }[];
        };
        return result.items.filter(
          (d) =>
            filenames.includes(d.display_name) &&
            d.folder_id === topic.id &&
            d.tag_ids.includes(tag.id),
        ).length;
      })
      .toBe(2);
    await page
      .getByRole("button", { name: "研究主题", exact: true })
      .locator("..")
      .dragTo(
        page
          .getByRole("button", { name: "资料归档", exact: true })
          .locator(".."),
      );
    await expect
      .poll(async () => {
        const result = (await (
          await request.get(`/api/knowledge-bases/${kb.id}/folders`)
        ).json()) as typeof folders;
        return result.find((f) => f.id === topic.id)?.parent_id;
      })
      .toBe(archive.id);
    const cycleResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/folders/${archive.id}`) &&
        r.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: "资料归档", exact: true })
      .locator("..")
      .dragTo(
        page.getByRole("button", { name: "子主题", exact: true }).locator(".."),
      );
    const rejected = await cycleResponse;
    expect(rejected.status()).toBeGreaterThanOrEqual(400);
    expect(rejected.status()).toBeLessThan(500);
    const unchanged = (await (
      await request.get(`/api/knowledge-bases/${kb.id}/folders`)
    ).json()) as typeof folders;
    expect(unchanged.find((f) => f.id === archive.id)?.parent_id).toBeNull();
    expect(unchanged.find((f) => f.id === topic.id)?.parent_id).toBe(
      archive.id,
    );
    expect(unchanged.find((f) => f.id === child.id)?.parent_id).toBe(topic.id);
    const filtered = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/knowledge-bases/${kb.id}/documents` &&
        url.searchParams.get("tag_ids") === tag.id
      );
    });
    await page.getByLabel("标签筛选", { exact: true }).selectOption(tag.id);
    expect((await filtered).ok()).toBeTruthy();
    await expect(page.locator(".document-row .document-tag")).toHaveText([
      "批量验收",
      "批量验收",
    ]);
    await page.getByLabel("标签筛选", { exact: true }).selectOption("");
    await page.getByLabel("文件类型筛选", { exact: true }).selectOption("pdf");
    await expect(page.locator(".document-row")).toHaveCount(0);
    await page.getByLabel("文件类型筛选", { exact: true }).selectOption("txt");
    await expect(page.locator(".document-row")).toHaveCount(2);
    await page.getByRole("button", { name: "排序文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "按名称", exact: false }).click();
    await expect(page.locator(".document-row .file-info>strong")).toHaveText(
      filenames,
    );
  } finally {
    await request
      .delete(`/api/knowledge-bases/${kb.id}`)
      .catch(() => undefined);
  }
});
