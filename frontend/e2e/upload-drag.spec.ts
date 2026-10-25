import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

test("真实目录和35个文件拖入，按数量与总量拆批并保留层级", async ({
  page,
  request,
  context,
}, testInfo) => {
  test.setTimeout(180000);
  const root = path.resolve(
    import.meta.dirname,
    "../../.data/test-runs/upload-ui-repair/fixtures",
  );
  const directory = path.join(root, "真实目录");
  await mkdir(path.join(directory, "附件"), { recursive: true });
  await mkdir(path.join(directory, "另外一层"), { recursive: true });
  const loose: string[] = [];
  const nested: string[] = [];
  for (let index = 0; index < 35; index++) {
    const name = path.join(root, `普通${index}.txt`);
    await writeFile(name, `ordinary document unique ${index}`);
    loose.push(name);
    const child = path.join(directory, `目录文件${index}.txt`);
    await writeFile(child, `directory document unique ${index}`);
    nested.push(child);
  }
  for (const subdirectory of ["附件", "另外一层"]) {
    const child = path.join(directory, subdirectory, "同名.txt");
    await writeFile(child, `${subdirectory} unique nested content`);
    nested.push(child);
  }
  const large: string[] = [];
  for (let index = 0; index < 3; index++) {
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 256 * 1024, " ");
    bytes.write(`Large valid text document marker ${index}\n`);
    const name = path.join(root, `较大${index}.txt`);
    await writeFile(name, bytes);
    large.push(name);
  }
  const response = await request.post("/api/knowledge-bases", {
    data: { name: `拖拽上传隔离验收 ${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  const kb = await response.json();
  const errors: string[] = [];
  const failures: { path: string; error?: string }[] = [];
  const responses: { status: number; count: number; statuses: string[] }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (req) =>
    failures.push({
      path: new URL(req.url()).pathname,
      error: req.failure()?.errorText,
    }),
  );
  page.on("response", async (result) => {
    if (!result.url().includes("/uploads")) return;
    const body = await result.json();
    responses.push({
      status: result.status(),
      count: body.items?.length || 0,
      statuses:
        body.items?.map((item: { status: string }) => item.status) || [],
    });
  });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const state = window as unknown as {
      __uploadRequests: unknown[];
      __nativeDrops: unknown[];
    };
    state.__uploadRequests = [];
    state.__nativeDrops = [];
    window.fetch = (input, init) => {
      if (
        String(input).includes("/uploads") &&
        init?.body instanceof FormData
      ) {
        const files = init.body.getAll("files") as File[];
        state.__uploadRequests.push({
          files: files.map((file) => ({ name: file.name, size: file.size })),
          bytes: files.reduce((total, file) => total + file.size, 0),
          paths: init.body.get("relative_paths"),
          target: init.body.get("folder_id"),
        });
      }
      return original(input, init);
    };
    document.addEventListener(
      "drop",
      (event) => {
        state.__nativeDrops.push(
          Array.from(event.dataTransfer?.items || []).map((item) => {
            const entry = item.webkitGetAsEntry();
            return { name: entry?.name, directory: entry?.isDirectory };
          }),
        );
      },
      true,
    );
  });
  try {
    const folderResponse = await request.post(
      `/api/knowledge-bases/${kb.id}/folders`,
      {
        data: { name: "投递目标" },
      },
    );
    expect(folderResponse.ok()).toBe(true);
    const destination = await folderResponse.json();
    await page.goto(`/document?kb=${kb.id}`);
    const pane = page.locator(".documents-pane:visible").first();
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "投递目标", exact: true }).click();
    const cdp = await context.newCDPSession(page);
    async function drop(files: string[]) {
      const box = (await pane.boundingBox())!;
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      for (const type of ["dragEnter", "dragOver", "drop"] as const)
        await cdp.send("Input.dispatchDragEvent", {
          type,
          x,
          y,
          data: { items: [], files, dragOperationsMask: 1 },
        });
    }
    await expect
      .poll(async () =>
        page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.includes("/settings/file-formats")),
        ),
      )
      .toBe(true);
    await drop(loose);
    await expect(
      pane.getByText("上传结果 · 35 个文件", { exact: true }),
    ).toBeVisible();
    expect(responses.map((result) => result.count)).toEqual([20, 15]);
    await pane.locator(".upload-results summary").click();
    await pane
      .getByRole("button", { name: "关闭上传结果", exact: true })
      .click();

    await drop([directory]);
    await expect(
      pane.getByText("上传结果 · 37 个文件", { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await pane.locator(".upload-results summary").click();
    await pane
      .getByRole("button", { name: "关闭上传结果", exact: true })
      .click();
    const beforeReload = await page.evaluate(() => {
      const state = window as unknown as {
        __uploadRequests: {
          files: { name: string; size: number }[];
          bytes: number;
          target: string;
        }[];
        __nativeDrops: { directory?: boolean }[][];
      };
      return { requests: state.__uploadRequests, drops: state.__nativeDrops };
    });
    expect(beforeReload.drops[1][0].directory).toBe(true);
    expect(beforeReload.requests).toHaveLength(39);
    expect(
      beforeReload.requests.every((value) => value.target === destination.id),
    ).toBe(true);
    // Use a smaller advertised budget for this browser case. The backend keeps
    // its real 200 MiB guard; no test changes its environment or daily data.
    await page.route("**/api/settings/file-formats", async (route) => {
      const result = await route.fetch();
      const catalog = await result.json();
      catalog.limits.max_batch_size_bytes = 20 * 1024 * 1024;
      await route.fulfill({ response: result, json: catalog });
    });
    await page.reload();
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "投递目标", exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.includes("/settings/file-formats")),
        ),
      )
      .toBe(true);
    const beforeLarge = responses.length;
    await drop(large);
    await expect(
      pane.getByText("上传结果 · 3 个文件", { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    expect(responses.slice(beforeLarge).map((result) => result.count)).toEqual([
      2, 1,
    ]);
    const documents = (
      await (
        await request.get(
          `/api/knowledge-bases/${kb.id}/documents?page_size=100`,
        )
      ).json()
    ).items;
    expect(documents).toHaveLength(75);
    expect(
      documents.filter(
        (doc: { folder_id: string }) => doc.folder_id === destination.id,
      ),
    ).toHaveLength(38);
    const folders = await (
      await request.get(`/api/knowledge-bases/${kb.id}/folders`)
    ).json();
    const rootFolder = folders.find(
      (folder: { name: string }) => folder.name === "真实目录",
    );
    expect(rootFolder.parent_id).toBe(destination.id);
    for (const name of ["附件", "另外一层"]) {
      const folder = folders.find(
        (value: { name: string }) => value.name === name,
      );
      expect(folder.parent_id).toBe(rootFolder.id);
      const document = documents.find(
        (value: { folder_id: string }) => value.folder_id === folder.id,
      );
      expect(document.original_filename).toBe("同名.txt");
      const downloaded = await request.get(
        `/api/documents/${document.id}/download`,
      );
      expect(await downloaded.body()).toEqual(
        await readFile(path.join(directory, name, "同名.txt")),
      );
    }
    const browserState = await page.evaluate(() => {
      const state = window as unknown as {
        __uploadRequests: { files: { size: number }[]; bytes: number }[];
        __nativeDrops: { directory?: boolean }[][];
      };
      return { requests: state.__uploadRequests, drops: state.__nativeDrops };
    });
    expect(browserState.requests.map((value) => value.files.length)).toEqual([
      2, 1,
    ]);
    expect(
      browserState.requests.every((value) => value.bytes <= 20 * 1024 * 1024),
    ).toBe(true);
    expect(
      responses.every(
        (result) =>
          result.status === 200 &&
          result.statuses.every((status) => status === "queued"),
      ),
    ).toBe(true);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
    await writeFile(
      testInfo.outputPath("upload-evidence.json"),
      JSON.stringify(
        {
          documents: documents.length,
          responses,
          requests: [...beforeReload.requests, ...browserState.requests],
          drops: [...beforeReload.drops, ...browserState.drops],
          errors,
          failures,
          largeCaseAdvertisedBudget: 20 * 1024 * 1024,
          backendBudgetUnchanged: 200 * 1024 * 1024,
        },
        null,
        2,
      ),
    );
  } finally {
    const deleted = await request.delete(`/api/knowledge-bases/${kb.id}`);
    expect(deleted.ok()).toBe(true);
  }
});
