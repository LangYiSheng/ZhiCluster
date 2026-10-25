import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("15种真实文件：上传、解析、检索、来源定位、阅读及原件下载", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  const fixtureRoot = path.resolve(
    import.meta.dirname,
    "../../.data/test-runs/formats-fixtures",
  );
  const fixtures = JSON.parse(
    await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"),
  ) as { extension: string; filename: string; marker: string }[];
  expect(fixtures).toHaveLength(15);
  const catalog = await (
    await request.get("/api/settings/file-formats")
  ).json();
  for (const fixture of fixtures)
    expect(
      catalog.formats.find(
        (format: { extension: string }) =>
          format.extension === fixture.extension,
      ),
    ).toMatchObject({ available: true });
  const created = await request.post("/api/knowledge-bases", {
    data: { name: `十五格式验收 ${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  const kb = await created.json();
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    if (req.url().includes("example.invalid")) externalRequests.push(req.url());
  });
  const documents: {
    id: string;
    fixture: (typeof fixtures)[number];
    bytes: Buffer;
  }[] = [];
  try {
    for (const fixture of fixtures) {
      const bytes = await readFile(path.join(fixtureRoot, fixture.filename));
      const mime = catalog.formats.find(
        (format: { extension: string }) =>
          format.extension === fixture.extension,
      ).mime_type;
      const response = await request.post(
        `/api/knowledge-bases/${kb.id}/uploads`,
        {
          multipart: {
            duplicate_policy: "copy",
            files: { name: fixture.filename, mimeType: mime, buffer: bytes },
          },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
      const result = await response.json();
      expect(result.items[0], fixture.extension).toMatchObject({
        status: "queued",
      });
      documents.push({ id: result.items[0].document.id, fixture, bytes });
    }
    await expect
      .poll(
        async () => {
          const rows = (
            await (
              await request.get(
                `/api/knowledge-bases/${kb.id}/documents?page_size=100`,
              )
            ).json()
          ).items;
          const failed = rows.filter(
            (row: { parse_status: string }) => row.parse_status === "failed",
          );
          expect(failed, JSON.stringify(failed)).toHaveLength(0);
          return rows.filter(
            (row: { parse_status: string }) => row.parse_status === "ready",
          ).length;
        },
        { timeout: 120000 },
      )
      .toBe(15);
    for (const { id, fixture, bytes } of documents) {
      const sections = await (
        await request.get(`/api/documents/${id}/sections`)
      ).json();
      expect(
        sections
          .map((section: { plain_text: string }) => section.plain_text)
          .join("\n"),
        fixture.extension,
      ).toContain(fixture.marker);
      const download = await request.get(`/api/documents/${id}/download`);
      expect(download.ok()).toBe(true);
      expect(await download.body()).toEqual(bytes);
      const search = await request.post("/api/search", {
        data: {
          query: fixture.marker,
          kb_ids: [kb.id],
          document_ids: [id],
          mode: "keyword",
          limit: 5,
        },
      });
      const hits = await search.json();
      expect(hits.items.length, fixture.extension).toBeGreaterThan(0);
      expect(hits.items[0].document_id).toBe(id);
      const anchor = hits.items[0].anchors || hits.items[0].anchor;
      if (["ppt", "pptx"].includes(fixture.extension))
        expect(anchor.slide_start).toBe(2);
      if (["xlsx", "xls"].includes(fixture.extension))
        expect(anchor.sheet_name).toBe("预算表");
      if (fixture.extension === "epub") expect(anchor.chapter_index).toBe(1);
      await page.goto(`/document?kb=${kb.id}&document=${id}&mode=read`);
      if (fixture.extension === "pdf")
        await page.getByRole("tab", { name: "文字", exact: true }).click();
      if (fixture.extension === "pdf") {
        await page
          .getByRole("button", { name: "下一页", exact: true })
          .first()
          .click();
      }
      await expect(page.locator(".text-reader")).toContainText(fixture.marker);
      if (["html", "htm"].includes(fixture.extension)) {
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { __formatScriptExecuted?: boolean })
                .__formatScriptExecuted,
          ),
        ).toBeUndefined();
        await expect(page.locator(".text-reader")).not.toContainText(
          "should-not-load",
        );
      }
      // Use the application's actual search → citation → reader path.
      await page.keyboard.press("Control+k");
      const searchDialog = page.getByRole("dialog", {
        name: "搜索知识",
        exact: true,
      });
      await searchDialog
        .getByRole("textbox", { name: "搜索关键词", exact: true })
        .fill(fixture.marker);
      await searchDialog
        .getByRole("combobox", { name: "搜索文件类型", exact: true })
        .click();
      await page
        .getByRole("option", {
          name: fixture.extension.toUpperCase(),
          exact: true,
        })
        .click();
      await expect(searchDialog.getByRole("option").first()).toBeVisible();
      await searchDialog.getByRole("option").first().click();
      await expect(page.locator(".citation-focus")).toContainText(
        fixture.marker,
      );
    }
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});
