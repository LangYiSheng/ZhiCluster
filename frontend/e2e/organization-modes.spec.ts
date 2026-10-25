import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { chooseOption } from "./helpers";

test("隔离HTTP模型：入库标签不移动，文件夹归并与空目录清理审批后可完整撤销", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.E2E_CONFIG_WRITES !== "1" || !baseURL?.includes(":13001"),
    "仅运行于专用隔离站点",
  );
  test.setTimeout(180000);
  const initial = await (await request.get("/api/settings/config")).json();
  expect(
    initial.llm.api_key_configured || initial.embedding.api_key_configured,
  ).toBe(false);
  const calls: { kind: string; model: string }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const system = String(body.messages?.[0]?.content || "");
      const organizing = system.includes("empty_folder_ids");
      calls.push({
        kind: organizing ? "organization" : "joint-enrichment",
        model: body.model,
      });
      const summary = {
        short_summary: "同一主题的资料。",
        detailed_summary: "两份资料都记录同一主题的研究方法。",
        keywords: ["研究"],
        main_topics: ["共同主题"],
      };
      let content;
      if (organizing) {
        const source = JSON.parse(body.messages[1].content);
        expect(system).toContain("本次仅整理文件夹");
        content = {
          summary: "将相似资料归入共同主题，空目录由服务计算。",
          folders: [{ ref: "topic", name: "共同主题", parent_id: null }],
          documents: source.documents.map((doc: { id: string }) => ({
            document_id: doc.id,
            folder_id: "ref:topic",
            reason: "主题一致",
          })),
          empty_folder_ids: [],
          delete_tag_ids: [],
        };
      } else {
        // A legacy provider may still return folder fields. Ingestion must
        // discard them rather than create/move into this unrequested folder.
        content = {
          summary,
          classification: {
            existing_folder_id: null,
            proposed_folder_path: "不能应用的旧目录建议",
            existing_tag_ids: [],
            new_tag_names: ["共同主题标签"],
            reason: "资料记录相同研究主题",
          },
        };
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify(content) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  let kb: { id: string } | undefined;
  const originals: { id: string; folderId: string; bytes: Buffer }[] = [];
  try {
    const configured = await request.put("/api/settings/config", {
      data: {
        revision: initial.revision,
        llm: {
          base_url: `http://host.docker.internal:${(server.address() as AddressInfo).port}/v1`,
          api_key: "synthetic-organization-key",
          model: "controlled-organization",
          supports_tools: false,
        },
      },
    });
    expect(configured.ok(), await configured.text()).toBe(true);
    const created = await request.post("/api/knowledge-bases", {
      data: { name: `整理模式隔离验收 ${Date.now()}` },
    });
    expect(created.ok()).toBe(true);
    kb = await created.json();
    const oldFolders: string[] = [];
    async function folder(name: string, parentId?: string) {
      const result = await request.post(
        `/api/knowledge-bases/${kb!.id}/folders`,
        { data: { name, parent_id: parentId || null } },
      );
      expect(result.ok()).toBe(true);
      const value = await result.json();
      oldFolders.push(value.id);
      return value.id as string;
    }
    const parent = await folder("旧归档");
    const left = await folder("旧位置甲", parent);
    const right = await folder("旧位置乙", parent);
    await folder("之前就空的目录");
    for (const [index, folderId] of [left, right].entries()) {
      const bytes = Buffer.from(
        `共同研究主题：方法记录${index}，真实原件内容保持不变。`,
      );
      const upload = await request.post(
        `/api/knowledge-bases/${kb.id}/uploads`,
        {
          multipart: {
            folder_id: folderId,
            files: {
              name: `研究${index}.txt`,
              mimeType: "text/plain",
              buffer: bytes,
            },
          },
        },
      );
      expect(upload.ok()).toBe(true);
      const body = await upload.json();
      expect(body.items[0].status).toBe("queued");
      originals.push({ id: body.items[0].document.id, folderId, bytes });
    }
    await expect
      .poll(
        async () => {
          const rows = (
            await (
              await request.get(`/api/knowledge-bases/${kb!.id}/documents`)
            ).json()
          ).items;
          return rows.filter(
            (doc: { summary_status: string; classification_status: string }) =>
              doc.summary_status === "ready" &&
              doc.classification_status === "ready",
          ).length;
        },
        { timeout: 60000 },
      )
      .toBe(2);
    const suggestions = await (
      await request.get(`/api/review/suggestions?kb_id=${kb.id}&status=pending`)
    ).json();
    expect(suggestions.items).toHaveLength(2);
    expect(
      suggestions.items.every(
        (item: {
          payload: {
            existing_folder_id?: string;
            proposed_folder_path?: string;
          };
        }) =>
          !item.payload.existing_folder_id &&
          !item.payload.proposed_folder_path,
      ),
    ).toBe(true);
    await page.goto(`/review?kb=${kb.id}&filter_kb=${kb.id}`);
    await page
      .getByRole("checkbox", { name: "选择本页建议", exact: true })
      .check();
    await page.getByRole("button", { name: "应用所选", exact: true }).click();
    const confirmTags = page.getByRole("dialog", {
      name: "应用 2 条分类建议",
      exact: true,
    });
    await expect(confirmTags).toContainText("保留文档当前位置");
    await confirmTags
      .getByRole("button", { name: "确认应用", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "逐项处理结果", exact: true }),
    ).toContainText("已应用");
    for (const original of originals) {
      const doc = await (
        await request.get(`/api/documents/${original.id}`)
      ).json();
      expect(doc.folder_id).toBe(original.folderId);
      expect(doc.short_summary).toBeTruthy();
      expect(doc.tag_ids.length).toBe(1);
    }
    const beforeOrganization = await (
      await request.get(`/api/knowledge-bases/${kb.id}/folders`)
    ).json();
    expect(
      beforeOrganization.map((item: { id: string }) => item.id).sort(),
    ).toEqual([...oldFolders].sort());

    await page
      .getByRole("button", { name: "自动整理现有文档", exact: true })
      .click();
    const creator = page.getByRole("dialog", {
      name: "自动整理现有文档",
      exact: true,
    });
    await expect(creator).toContainText("整理范围 · 已选 2 / 2 份文档");
    await chooseOption(page, "整理内容", "只整理文件夹");
    await expect(
      creator.getByRole("checkbox", {
        name: "清理整理后空文件夹",
        exact: true,
      }),
    ).toBeChecked();
    await expect(creator).toContainText("全库空目录");
    const creating = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/review/plans") &&
        response.request().method() === "POST",
    );
    await creator
      .getByRole("button", { name: "生成待审方案", exact: true })
      .click();
    const createdRun = await (await creating).json();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/agent/runs/${createdRun.id}`)).json())
            .status,
        { timeout: 60000 },
      )
      .toBe("pending_review");
    await page.goto(
      `/review?kb=${kb.id}&filter_kb=${kb.id}&tab=plans&run=${createdRun.id}`,
    );
    const editor = page.getByRole("region", {
      name: "整理方案详情",
      exact: true,
    });
    await expect(editor).toContainText("只整理文件夹");
    await expect(editor).toContainText("清理全库空目录");
    const run = await (
      await request.get(`/api/agent/runs/${createdRun.id}`)
    ).json();
    expect(run.plan.payload.organization.mode).toBe("folders");
    expect(
      run.plan.payload.operations.some(
        (op: { type: string }) => op.type === "update_document_tags",
      ),
    ).toBe(false);
    expect(
      run.plan.payload.operations
        .find((op: { type: string }) => op.type === "trash_empty_folders")
        .target_ids.sort(),
    ).toEqual([...oldFolders].sort());
    for (const original of originals)
      expect(
        (await (await request.get(`/api/documents/${original.id}`)).json())
          .folder_id,
      ).toBe(original.folderId);
    await editor
      .getByRole("button", { name: "批准所选并执行", exact: true })
      .click();
    const confirm = page.getByRole("dialog", {
      name: "确认包含删除操作的方案",
      exact: true,
    });
    await expect(confirm).toContainText("之前就空的目录");
    await confirm
      .getByRole("button", { name: "确认删除并执行", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "撤销此次整理", exact: true }),
    ).toBeVisible();
    const mergedFolders = await (
      await request.get(`/api/knowledge-bases/${kb.id}/folders`)
    ).json();
    expect(mergedFolders).toHaveLength(1);
    expect(mergedFolders[0].name).toBe("共同主题");
    for (const original of originals) {
      const doc = await (
        await request.get(`/api/documents/${original.id}`)
      ).json();
      expect(doc.folder_id).toBe(mergedFolders[0].id);
      expect(doc.tag_ids).toHaveLength(1);
    }
    await editor
      .getByRole("button", { name: "撤销此次整理", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "撤销此次整理", exact: true })
      .getByRole("button", { name: "确认撤销", exact: true })
      .click();
    await expect(editor).toContainText("已撤销");
    const restoredFolders = await (
      await request.get(`/api/knowledge-bases/${kb.id}/folders`)
    ).json();
    expect(
      restoredFolders.map((item: { id: string }) => item.id).sort(),
    ).toEqual([...oldFolders].sort());
    for (const original of originals) {
      const doc = await (
        await request.get(`/api/documents/${original.id}`)
      ).json();
      expect(doc.folder_id).toBe(original.folderId);
      expect(doc.tag_ids).toHaveLength(1);
      expect(
        await (
          await request.get(`/api/documents/${original.id}/download`)
        ).body(),
      ).toEqual(original.bytes);
    }
    expect(errors).toEqual([]);
    expect(
      calls.filter((call) => call.kind === "joint-enrichment"),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.kind === "organization")).toHaveLength(
      1,
    );
    await writeFile(
      testInfo.outputPath("organization-evidence.json"),
      JSON.stringify(
        {
          documents: originals.length,
          calls,
          plan: run.plan,
          cleanedFolderIds: oldFolders,
          completeUndo: true,
          errors,
        },
        null,
        2,
      ),
    );
    await page.screenshot({
      path: testInfo.outputPath("organization-undone.png"),
      fullPage: true,
    });
  } finally {
    if (kb) await request.delete(`/api/knowledge-bases/${kb.id}`);
    const current = await (await request.get("/api/settings/config")).json();
    const { api_key_configured: llmKey, ...llm } = initial.llm;
    const { api_key_configured: embeddingKey, ...embedding } =
      initial.embedding;
    void llmKey;
    void embeddingKey;
    const restored = await request.put("/api/settings/config", {
      data: {
        revision: current.revision,
        llm: { ...llm, clear_api_key: true },
        embedding: { ...embedding, clear_api_key: true },
        processing: initial.processing,
      },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
