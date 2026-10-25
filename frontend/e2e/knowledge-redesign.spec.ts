import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chooseOption, waitForParsed } from "./helpers";

test("资料浏览当前目录、搜索筛选、排序、添加菜单及知识库外观持久化", async ({
  page,
  request,
}, testInfo) => {
  const kb = await (
    await request.post("/api/knowledge-bases", {
      data: { name: `浏览验收 ${Date.now()}`, description: "资料按文件夹收集" },
    })
  ).json();
  const folder = await (
    await request.post(`/api/knowledge-bases/${kb.id}/folders`, {
      data: { name: "工作材料" },
    })
  ).json();
  try {
    await request.post(`/api/knowledge-bases/${kb.id}/uploads`, {
      multipart: {
        files: {
          name: "根目录计划.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# 计划\n这是根目录中的工作计划。"),
        },
      },
    });
    await request.post(`/api/knowledge-bases/${kb.id}/uploads`, {
      multipart: {
        folder_id: folder.id,
        files: {
          name: "子目录细节.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("蓝色验收主题，目录里的详细资料。"),
        },
      },
    });
    await waitForParsed(request, kb.id, ["根目录计划.md", "子目录细节.txt"]);
    await page.goto(`/chat?kb=${kb.id}`);
    await expect(
      page.locator(".workspace-header .workspace-search"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "浏览资料", exact: true }).click();
    const pane = page.locator(".documents-pane:visible");
    await expect(
      pane.getByRole("heading", { name: kb.name, exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByText("根目录计划.md", { exact: true }),
    ).toBeVisible();
    await expect(pane.getByText("子目录细节.txt", { exact: true })).toHaveCount(
      0,
    );
    await pane.getByRole("button", { name: "工作材料", exact: true }).click();
    await expect(
      pane.getByText("子目录细节.txt", { exact: true }),
    ).toBeVisible();
    await expect(pane.getByText("根目录计划.md", { exact: true })).toHaveCount(
      0,
    );
    await pane.getByRole("button", { name: "后退", exact: true }).click();
    await expect(
      pane.getByText("根目录计划.md", { exact: true }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "前进", exact: true }).click();
    await expect(
      pane.getByText("子目录细节.txt", { exact: true }),
    ).toBeVisible();
    await pane
      .getByRole("button", { name: "知识库根目录", exact: true })
      .click();
    await pane.getByRole("button", { name: "排序文件", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "更新时间",
      "创建时间",
      "大小",
      "类型",
      "名称",
    ]);
    await page.getByRole("menuitem", { name: "名称", exact: true }).click();
    await pane.getByRole("button", { name: "添加文件", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "本地文件",
      "本地文件夹",
      "新建文件夹",
    ]);
    await page
      .getByRole("menuitem", { name: "新建文件夹", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "新建文件夹",
      exact: true,
    });
    await dialog.getByLabel("名称", { exact: true }).fill("新增目录");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      pane.getByRole("button", { name: "新增目录", exact: true }),
    ).toBeVisible();

    const selectedDir = testInfo.outputPath("本地资料");
    await mkdir(path.join(selectedDir, "内层"), { recursive: true });
    await writeFile(
      path.join(selectedDir, "内层", "目录导入.txt"),
      "这是保持层级的本地文件夹上传。",
    );
    for (let index = 0; index < 20; index++) {
      await writeFile(
        path.join(selectedDir, `批量资料${index}.txt`),
        `这是目录导入的第 ${index} 份独立资料。`,
      );
    }
    await pane
      .locator('input[aria-label="上传本地文件夹"]')
      .setInputFiles(selectedDir);
    await expect(
      pane.getByRole("button", { name: "本地资料", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/knowledge-bases/${kb.id}/documents`)
            ).json()
          ).total,
      )
      .toBe(23);
    await pane.getByRole("button", { name: "本地资料", exact: true }).click();
    await pane.getByRole("button", { name: "内层", exact: true }).click();
    await expect(pane.getByText("目录导入.txt", { exact: true })).toBeVisible();

    await pane
      .getByRole("button", { name: "搜索知识库资料", exact: true })
      .click();
    await pane
      .getByRole("textbox", { name: "在知识库中搜索", exact: true })
      .fill("根目录计划");
    await expect(
      pane.getByText("根目录计划.md", { exact: true }),
    ).toBeVisible();
    await chooseOption(page, "文件类型筛选", "TXT");
    await expect(pane.getByText("暂无匹配内容", { exact: true })).toBeVisible();
    await pane.getByRole("button", { name: "退出搜索", exact: true }).click();
    await expect(
      pane.getByRole("combobox", { name: "文件类型筛选", exact: true }),
    ).toHaveCount(0);
    await pane.getByRole("button", { name: "知识库操作", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "编辑知识库", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "编辑知识库",
      exact: true,
    });
    await editor.getByLabel("名称", { exact: true }).fill(`${kb.name} 已编辑`);
    await editor
      .getByRole("textbox", { name: "描述", exact: true })
      .fill("图标和颜色已保存");
    await editor.getByRole("button", { name: "书籍图标", exact: true }).click();
    await editor
      .getByRole("button", { name: "颜色 #4b8bd8", exact: true })
      .click();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      pane.getByRole("heading", { name: `${kb.name} 已编辑`, exact: true }),
    ).toBeVisible();
    const saved = await (
      await request.get(`/api/knowledge-bases/${kb.id}`)
    ).json();
    expect(saved).toMatchObject({
      icon: "book",
      color: "#4b8bd8",
      description: "图标和颜色已保存",
    });
    await page.screenshot({
      path: testInfo.outputPath("explorer-desktop.png"),
      fullPage: true,
    });
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(pane).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await pane.getByRole("button", { name: "排序文件", exact: true }).click();
      const box = (await page.getByRole("menu").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({
        path: testInfo.outputPath(`explorer-${viewport.width}.png`),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
    }
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});

test("新库空历史、设置六套配色和独立预览、真实统计及窄屏菜单", async ({
  page,
  request,
}, testInfo) => {
  const kb = await (
    await request.post("/api/knowledge-bases", {
      data: { name: `设置验收 ${Date.now()}` },
    })
  ).json();
  try {
    await page.goto(`/chat?kb=${kb.id}`);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await expect(
      page.getByText("还没有历史对话", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "知识库问题" })
      .fill("切换设置后仍在的草稿");
    await page
      .getByRole("button", { name: "选择模型与思考模式", exact: true })
      .click();
    await page.getByRole("button", { name: "思考", exact: true }).click();
    await page
      .getByRole("link", { name: "设置首选与自定义模型", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "聊天模型", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "选择模型与思考模式", exact: true }),
    ).toContainText("思考");
    await expect(page.getByRole("textbox", { name: "知识库问题" })).toHaveValue(
      "切换设置后仍在的草稿",
    );
    await page.goto(`/settings?kb=${kb.id}`);
    await expect(page.locator(".zc-palette-choice")).toHaveCount(6);
    const original = await page.locator("html").getAttribute("data-palette");
    await page.locator(".zc-palette-choice").last().click();
    const preview = page.locator(".zc-theme-preview");
    await expect(preview).not.toHaveAttribute(
      "data-palette",
      original || "ink",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-palette",
      original || "ink",
    );
    await page.getByRole("tab", { name: "文字与阅读", exact: true }).click();
    await expect(page.locator(".zc-preview-reading")).toBeVisible();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-palette",
      (await preview.getAttribute("data-palette")) || "ink",
    );
    await page.getByRole("button", { name: "用量与统计", exact: true }).click();
    const stats = await (
      await request.get(`/api/settings/statistics?kb_id=${kb.id}`)
    ).json();
    expect(stats).toMatchObject({
      knowledge_bases: 1,
      documents: 0,
      conversations: 0,
      storage_bytes: 0,
    });
    await expect(
      page.getByRole("heading", { name: "知识工作区统计", exact: true }),
    ).toBeVisible();
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`settings-${viewport.width}.png`),
        fullPage: true,
      });
      await page.goto(`/chat?kb=${kb.id}`);
      const modelTrigger = page.getByRole("button", { name: "选择模型与思考模式", exact: true });
      expect((await modelTrigger.locator("span").boundingBox())!.width).toBeGreaterThan(30);
      await page
        .getByRole("button", { name: "选择模型与思考模式", exact: true })
        .click();
      const menu = page.getByRole("dialog", {
        name: "模型与思考模式",
        exact: true,
      });
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await page.keyboard.press("Escape");
      await page.goto(`/settings?kb=${kb.id}&section=statistics`);
    }
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});

test("隔离HTTP模型：多模型实际选择、快速/思考正文工具流、每库唯一嵌入", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.E2E_CONFIG_WRITES !== "1",
    "仅允许专用隔离站点修改模型配置",
  );
  const initial = await (await request.get("/api/settings/config")).json();
  expect(
    initial.llm.api_key_configured || initial.embedding.api_key_configured,
  ).toBe(false);
  const calls: {
    url: string;
    model: string;
    tools: boolean;
    stream: boolean;
  }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: ["chat-a", "chat-b", "embed-two", "embed-three"].map((id) => ({
            id,
          })),
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({
      url: req.url || "",
      model: body.model,
      tools: !!body.tools,
      stream: !!body.stream,
    });
    if (req.url === "/v1/embeddings") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: (body.input || []).map((_: string, index: number) => ({
            index,
            embedding: body.model === "embed-two" ? [1, 0] : [1, 0, 0],
          })),
        }),
      );
      return;
    }
    const tool = body.tools?.[0]?.function?.name;
    const toolReturned = body.messages?.some(
      (message: { role: string }) => message.role === "tool",
    );
    const call = {
      id: "read-1",
      type: "function",
      function: {
        name: tool,
        arguments:
          tool === "capability_probe"
            ? '{"value":"OK"}'
            : '{"query":"验收颜色"}',
      },
    };
    const content = tool
      ? toolReturned
        ? "资料查阅完毕。"
        : "我先查阅颜色资料。"
      : "资料里的验收颜色是蓝色。[S1]";
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content, reasoning_content: "私有推理不应显示" } }] })}\n\n`,
      );
      if (tool && !toolReturned)
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] })}\n\n`,
        );
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: tool && !toolReturned ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: body.response_format
                  ? JSON.stringify({
                      short_summary: "蓝色资料",
                      detailed_summary: "验收颜色是蓝色",
                      keywords: ["颜色"],
                      main_topics: ["验收"],
                      existing_tag_ids: [],
                      new_tag_names: [],
                      proposed_folder_path: null,
                      reason: "测试",
                    })
                  : content,
                ...(tool && !toolReturned ? { tool_calls: [call] } : {}),
              },
            },
          ],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const url = `http://host.docker.internal:${(server.address() as AddressInfo).port}/v1`;
  const ids: string[] = [];
  try {
    const result = await request.put("/api/settings/config", {
      data: {
        revision: initial.revision,
        llm: {
          base_url: url,
          api_key: "synthetic-redesign-key",
          model: "chat-a",
          models: ["chat-a", "chat-b"],
          supports_tools: true,
        },
        embedding: {
          base_url: url,
          api_key: "synthetic-redesign-key",
          model: "embed-three",
          dimension: 3,
        },
      },
    });
    expect(result.ok(), await result.text()).toBe(true);
    for (const [name, model, dimension] of [
      ["二维护库", "embed-two", 2],
      ["三维护库", "embed-three", 3],
    ] as const) {
      const kb = await (
        await request.post("/api/knowledge-bases", {
          data: {
            name,
            embedding_model: model,
            embedding_dimension: dimension,
          },
        })
      ).json();
      ids.push(kb.id);
      await request.post(`/api/knowledge-bases/${kb.id}/uploads`, {
        multipart: {
          files: {
            name: `${name}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from(
              "验收颜色是蓝色。蓝色资料用于这次工作区功能验证。",
            ),
          },
        },
      });
      await waitForParsed(request, kb.id, [`${name}.txt`]);
      await expect
        .poll(
          async () =>
            (
              await (
                await request.get(`/api/settings/statistics?kb_id=${kb.id}`)
              ).json()
            ).indexed_documents,
        )
        .toBe(1);
    }
    const search = await request.post("/api/search", {
      data: { query: "验收颜色", kb_ids: ids, mode: "hybrid" },
    });
    expect(search.ok()).toBe(true);
    expect(
      new Set(
        calls
          .filter((call) => call.url === "/v1/embeddings")
          .map((call) => call.model),
      ),
    ).toEqual(new Set(["embed-two", "embed-three"]));
    await page.goto(`/chat?kb=${ids[0]}`);
    await page
      .getByRole("button", { name: "选择模型与思考模式", exact: true })
      .click();
    await page.getByRole("button", { name: "chat-b", exact: true }).click();
    await page
      .getByRole("textbox", { name: "知识库问题" })
      .fill("验收颜色是什么？");
    await page.getByRole("button", { name: "发送问题", exact: true }).click();
    await expect(page.locator(".message-assistant .markdown")).toContainText(
      "蓝色",
    );
    await expect
      .poll(() =>
        calls.some(
          (call) => call.model === "chat-b" && call.stream && !call.tools,
        ),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "选择模型与思考模式", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "选择模型与思考模式", exact: true })
      .click();
    await page.getByRole("button", { name: "思考", exact: true }).click();
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "知识库问题" })
      .fill("请继续查阅验收颜色");
    await page.getByRole("button", { name: "发送问题", exact: true }).click();
    await expect(
      page.locator(".message-assistant .markdown").last(),
    ).toContainText("我先查阅颜色资料");
    await expect(
      page.getByRole("button", { name: "选择模型与思考模式", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".chat-progress").last()).not.toHaveAttribute(
      "open",
    );
    await expect(
      page.getByText("私有推理不应显示", { exact: false }),
    ).toHaveCount(0);
    expect(
      calls.some(
        (call) => call.model === "chat-b" && call.tools && call.stream,
      ),
    ).toBe(true);
    const history = await (
      await request.get(`/api/conversations?kb_id=${ids[1]}`)
    ).json();
    expect(history).toEqual([]);
  } finally {
    for (const id of ids) await request.delete(`/api/knowledge-bases/${id}`);
    const current = await (await request.get("/api/settings/config")).json();
    const { api_key_configured: llmKey, ...llm } = initial.llm;
    const { api_key_configured: embeddingKey, ...embedding } =
      initial.embedding;
    void llmKey;
    void embeddingKey;
    await request.put("/api/settings/config", {
      data: {
        revision: current.revision,
        llm: { ...llm, clear_api_key: true },
        embedding: { ...embedding, clear_api_key: true },
        processing: initial.processing,
      },
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
