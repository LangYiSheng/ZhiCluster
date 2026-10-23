import { test, expect } from "@playwright/test";
import type { Job } from "../src/lib/api";
import { waitForParsed } from "./helpers";

test("未配置模型的真实任务集中显示、重试和阅读入口", async ({
  page,
  request,
}) => {
  const status = await (await request.get("/api/settings/model-status")).json();
  test.skip(
    status.llm?.configured || status.embedding?.configured,
    "此验收只在两个模型均未配置时运行，避免产生外部模型调用",
  );
  const suffix = Date.now();
  const name = `任务验收-${suffix}.txt`;
  const text = `任务中心来源${suffix}\n这是一份真实上传的测试文档。`;
  const create = await request.post("/api/knowledge-bases", {
    data: { name: `任务验收 ${suffix}` },
  });
  expect(create.ok()).toBeTruthy();
  const kb = await create.json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const upload = await request.post(`/api/knowledge-bases/${kb.id}/uploads`, {
      multipart: {
        files: { name, mimeType: "text/plain", buffer: Buffer.from(text) },
      },
    });
    expect(upload.ok()).toBeTruthy();
    const uploaded = await upload.json();
    const documentId = uploaded.items[0].document.id as string;
    const jobId = uploaded.jobs[0].id as string;
    await waitForParsed(request, kb.id, [name]);
    const jobPath = `/api/ingestion/jobs/${jobId}`;
    await expect
      .poll(async () => (await (await request.get(jobPath)).json()).status, {
        timeout: 30000,
      })
      .toBe("partial_ready");
    await page.goto(`/tasks?kb=${kb.id}`);
    const row = page.getByRole("article").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("待配置模型");
    await expect(row).toContainText("需要配置模型服务");
    await expect(row.getByRole("progressbar")).toHaveCount(0);
    await expect(row).not.toContainText("100%");
    await expect(row).not.toContainText("已完成");

    await row.getByRole("link", { name, exact: true }).click();
    await expect(page.locator(".text-reader")).toContainText(text);
    await expect(page.locator(".document-detail")).toHaveCount(0);
    await page.getByRole("button", { name: "文档操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "查看属性", exact: true }).click();
    await expect(
      page.locator(".document-detail > section").first(),
    ).toContainText("内容摘要");
    await expect(
      page
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "文档属性" }) }),
    ).not.toHaveAttribute("open");
    await page
      .getByRole("link", {
        name: "有任务需要处理，前往任务列表查看与重试",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/tasks\\?kb=${kb.id}&document=${documentId}`),
    );
    await expect(row).toBeVisible();
    const retriedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/ingestion/jobs/${jobId}/retry`) &&
        response.request().method() === "POST",
    );
    await row
      .getByRole("button", { name: `重试 ${name}`, exact: true })
      .click();
    const response = await retriedResponse;
    expect(response.ok()).toBeTruthy();
    const retried = (await response.json()) as Job;
    expect(retried.status).toBe("queued");
    expect(retried.stage).toBe("queued");
    expect(retried.progress).toBe(0);
    await expect
      .poll(async () => (await (await request.get(jobPath)).json()).status, {
        timeout: 30000,
      })
      .toBe("partial_ready");
    await expect(row).toContainText("待配置模型", { timeout: 10000 });
    await expect(row.getByRole("progressbar")).toHaveCount(0);
    for (const viewport of [
      { width: 320, height: 640 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(row).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      await page.screenshot({
        path: `test-results/tasks-${viewport.width}x${viewport.height}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await row.getByRole("link", { name: "配置模型", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/settings\\?kb=${kb.id}&section=models`),
    );
    await expect(
      page.getByRole("heading", { name: "模型连接", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});
