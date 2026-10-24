import { test, expect } from "@playwright/test";
import { waitForParsed } from "./helpers";

test("真实目录落点上传、副本确认与跨库拖放隔离", async ({ page, request }) => {
  const create = async (name: string) => {
    const response = await request.post("/api/knowledge-bases", {
      data: { name },
    });
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<{ id: string }>;
  };
  const kb = await create(`管理完整性-${Date.now()}`);
  const other = await create(`管理完整性源库-${Date.now()}`);
  const folder = async (kbId: string, name: string, parent_id?: string) => {
    const response = await request.post(
      `/api/knowledge-bases/${kbId}/folders`,
      { data: { name, parent_id } },
    );
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<{ id: string; parent_id: string | null }>;
  };
  try {
    const selected = await folder(kb.id, "当前目录");
    const target = await folder(kb.id, "投递目录");
    const literal = await folder(kb.id, "研究 / 论文");
    const research = await folder(kb.id, "研究");
    const nested = await folder(kb.id, "论文", research.id);
    const foreignParent = await folder(other.id, "源父目录");
    const foreign = await folder(other.id, "源子目录", foreignParent.id);
    await page.goto(`/document?kb=${kb.id}`);
    await page.getByRole("button", { name: "当前目录", exact: true }).click();
    async function dropFile() {
      const transfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(
          new File(["真实落点内容，必须存到投递目录。"], "目录落点.txt", {
            type: "text/plain",
          }),
        );
        return data;
      });
      await page
        .getByRole("button", { name: "投递目录", exact: true })
        .locator("..")
        .dispatchEvent("drop", { dataTransfer: transfer });
      await transfer.dispose();
    }
    const uploaded = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/knowledge-bases/${kb.id}/uploads`) &&
        response.request().method() === "POST",
    );
    await dropFile();
    expect((await uploaded).ok()).toBeTruthy();
    await waitForParsed(request, kb.id, ["目录落点.txt"]);
    const documents = await request.get(
      `/api/knowledge-bases/${kb.id}/documents`,
    );
    expect((await documents.json()).items[0].folder_id).toBe(target.id);
    await expect(page.locator(".document-row")).toHaveCount(0);
    await dropFile();
    const confirmation = page.getByRole("dialog", { name: "检测到相同内容" });
    await expect(confirmation).toContainText("目录落点.txt");
    await expect(confirmation).toContainText("投递目录");
    const copied = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/knowledge-bases/${kb.id}/uploads`) &&
        response.request().method() === "POST",
    );
    await confirmation.getByRole("button", { name: "保留副本" }).click();
    expect((await copied).ok()).toBeTruthy();
    await expect
      .poll(async () => {
        const response = await request.get(
          `/api/knowledge-bases/${kb.id}/documents`,
        );
        const data = await response.json();
        return data.items.filter(
          (item: { folder_id: string }) => item.folder_id === target.id,
        ).length;
      })
      .toBe(2);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PATCH" &&
        request.url().includes(`/folders/${foreign.id}`)
      )
        writes.push(request.url());
    });
    const transfer = await page.evaluateHandle((id) => {
      const data = new DataTransfer();
      data.setData("application/x-zhicluster-folder", id);
      return data;
    }, foreign.id);
    await page
      .locator(".folder-root-drop")
      .dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await expect(
      page.getByText("只能移动当前知识库中的有效文件夹"),
    ).toBeVisible();
    expect(writes).toEqual([]);
    const source = await request.get(
      `/api/knowledge-bases/${other.id}/folders`,
    );
    expect(
      (await source.json()).find(
        (entry: { id: string }) => entry.id === foreign.id,
      ).parent_id,
    ).toBe(foreignParent.id);
    expect(selected.id).not.toBe(target.id);
    await page.getByRole("button", { name: "投递目录", exact: true }).click();
    await page
      .locator(".document-row")
      .first()
      .getByRole("button", { name: "目录落点.txt文档菜单", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "移动到…", exact: true }).click();
    const move = page.getByRole("dialog", { name: "移动文档" });
    await move
      .getByRole("textbox", { name: "搜索目标文件夹" })
      .fill("研究 / 论文");
    await move.getByRole("combobox", { name: "目标文件夹" }).click();
    await expect(
      page.getByRole("option", { name: '"研究 / 论文"', exact: true }),
    ).toBeVisible();
    await page
      .getByRole("option", { name: "研究 / 论文", exact: true })
      .click();
    await page.screenshot({
      path: "test-results/folder-search-destination.png",
      fullPage: true,
    });
    const moved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/documents/batch") &&
        response.request().method() === "POST",
    );
    await move.getByRole("button", { name: "保存", exact: true }).click();
    const movedResponse = await moved;
    expect(movedResponse.ok()).toBeTruthy();
    const movedDocument = (await movedResponse.json()).items[0];
    expect(movedDocument.folder_id).toBe(nested.id);
    expect(movedDocument.folder_id).not.toBe(literal.id);
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
    await request.delete(`/api/knowledge-bases/${other.id}`);
  }
});

test("外部移动清理隐藏选择，删除当前目录后恢复有效上传范围", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/knowledge-bases", {
    data: { name: `列表新鲜性-${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const kb = (await response.json()) as { id: string };
  try {
    const createFolder = async (name: string) => {
      const response = await request.post(
        `/api/knowledge-bases/${kb.id}/folders`,
        { data: { name } },
      );
      expect(response.ok()).toBeTruthy();
      return response.json() as Promise<{ id: string }>;
    };
    const current = await createFolder("正在浏览");
    const outside = await createFolder("外部移动目标");
    const uploaded = await request.post(
      `/api/knowledge-bases/${kb.id}/uploads`,
      {
        multipart: {
          folder_id: current.id,
          files: {
            name: "外部移动.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("此文档会被另一窗口移出当前目录。"),
          },
        },
      },
    );
    expect(uploaded.ok()).toBeTruthy();
    const document = (await uploaded.json()).items[0].document as {
      id: string;
    };
    await waitForParsed(request, kb.id, ["外部移动.txt"]);
    await page.goto(`/document?kb=${kb.id}`);
    await page.getByRole("button", { name: "正在浏览", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择 外部移动.txt" }).check();
    await expect(page.getByText("已选 1 项")).toBeVisible();
    const moved = await request.patch(`/api/documents/${document.id}`, {
      data: { folder_id: outside.id },
    });
    expect(moved.ok()).toBeTruthy();
    await page.getByRole("button", { name: "刷新文件" }).click();
    await expect(page.locator(".document-row")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "批量操作", exact: true }),
    ).toHaveCount(0);
    expect(
      (await request.get(`/api/documents/${document.id}`)).ok(),
    ).toBeTruthy();
    expect(
      (await request.delete(`/api/folders/${current.id}`)).ok(),
    ).toBeTruthy();
    await page.getByRole("button", { name: "刷新文件" }).click();
    await expect(page.locator(".document-navigation .selected")).toContainText(
      "全部文档",
    );
    const next = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/knowledge-bases/${kb.id}/uploads`) &&
        response.request().method() === "POST",
    );
    await page.getByLabel("上传文档", { exact: true }).setInputFiles({
      name: "恢复范围.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("失效目录恢复后保存到根目录。"),
    });
    const result = await next;
    expect(result.ok()).toBeTruthy();
    expect((await result.json()).items[0].document.folder_id).toBeNull();
    await page.screenshot({
      path: "test-results/management-integrity.png",
      fullPage: true,
    });
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});
