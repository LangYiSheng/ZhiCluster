import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RuntimeConfig } from "../src/lib/settings";
import { configDraft } from "../src/lib/settings";

type JobState = { kind: string; status: string; error: string };

test("字体、按需资料栏、草稿延续与桌面/手机/横屏布局", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/knowledge-bases", {
    data: { name: `界面验收 ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const kb = (await response.json()) as { id: string };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`/chat?kb=${kb.id}`);
    const composer = page.getByRole("textbox", { name: "知识库问题" });
    await expect(composer).toBeVisible();
    await composer.fill("打开设置以后，这段草稿还在。");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "外观与布局" }),
    ).toBeVisible();
    await expect(page.locator(".reference-pane:visible")).toHaveCount(0);
    await expect(page.locator(".library-slot")).toBeHidden();
    await page.getByLabel("显示模式", { exact: true }).selectOption("dark");
    await page.getByLabel("字体搭配", { exact: true }).selectOption("sans");
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("放弃未保存的修改");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-font-pairing",
      "sans",
    );
    await page.reload();
    await expect(page.getByLabel("字体搭配", { exact: true })).toHaveValue(
      "sans",
    );
    await page.getByLabel("显示模式", { exact: true }).selectOption("light");
    await page.getByLabel("字体搭配", { exact: true }).selectOption("mixed");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await expect(composer).toHaveValue("打开设置以后，这段草稿还在。");
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => ({
      ui: getComputedStyle(document.body).fontFamily,
      uiLoaded: [...document.fonts].some(
        (face) =>
          face.family.includes("ZhiCluster Sans") && face.status === "loaded",
      ),
      titleLoaded: [...document.fonts].some(
        (face) =>
          face.family.includes("ZhiCluster Serif") && face.status === "loaded",
      ),
    }));
    expect(fonts.ui).toContain("ZhiCluster Sans");
    expect(fonts.uiLoaded && fonts.titleLoaded).toBeTruthy();
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.getByRole("button", { name: "浏览资料", exact: true }).click();
    const workspace = await page.locator(".chat-main").boundingBox();
    const contextPane = await page.locator(".reference-pane").boundingBox();
    expect(contextPane!.x).toBeGreaterThanOrEqual(
      workspace!.x + workspace!.width - 1,
    );
    await page
      .getByRole("button", { name: "折叠知识库栏", exact: true })
      .click();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page
      .getByRole("button", { name: "关闭参考资料", exact: true })
      .click();
    for (const [width, height] of [
      [1440, 900],
      [1100, 800],
      [900, 780],
      [390, 844],
      [844, 390],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(composer).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
      const inputBox = await composer.boundingBox();
      expect(inputBox!.width).toBeGreaterThan(200);
      expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(height);
      await page.screenshot({
        path: `test-results/redesign-chat-${width}x${height}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "展开知识库栏", exact: true })
      .click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      await page.getByRole("button", { name: "模型连接", exact: true }).click();
      await expect(
        page
          .getByRole("region", { name: "聊天模型", exact: true })
          .getByLabel("服务地址", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      await page.screenshot({
        path: `test-results/redesign-settings-${width}x${height}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/knowledge-bases/${kb.id}`);
  }
});

test("隔离库真实HTTP：草稿连接测试、网页保存、密钥保留清除、冲突与worker热刷新", async ({
  page,
  context,
  request,
}) => {
  test.skip(
    process.env.E2E_CONFIG_WRITES !== "1",
    "仅在专用隔离数据库启用配置写入验收，禁止修改日常配置",
  );
  const initial = (await (
    await request.get("/api/settings/config")
  ).json()) as RuntimeConfig;
  expect(
    initial.llm.api_key_configured || initial.embedding.api_key_configured,
    "验收站点不得包含真实密钥",
  ).toBeFalsy();
  const calls: {
    path: string;
    model: string;
    count: number;
    authorization: string;
  }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as {
      model: string;
      input?: string[];
      tools?: unknown;
      stream?: boolean;
    };
    calls.push({
      path: req.url!,
      model: body.model,
      count: body.input?.length || 0,
      authorization: req.headers.authorization || "",
    });
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "受控HTTP回答：知识配置已生效" } }] })}\n\n`,
      );
      setTimeout(
        () =>
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "，来源可追溯。[S1]" } }] })}\n\ndata: [DONE]\n\n`,
          ),
        4000,
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/embeddings")
      res.end(
        JSON.stringify({
          data: (body.input || []).map((_, index) => ({
            index,
            embedding: [1, 0.25, 0.5],
          })),
        }),
      );
    else
      res.end(
        JSON.stringify({
          choices: [
            {
              message: body.tools
                ? {
                    content: "",
                    tool_calls: [
                      {
                        id: "probe",
                        type: "function",
                        function: {
                          name: "capability_probe",
                          arguments: '{"value":"OK"}',
                        },
                      },
                    ],
                  }
                : { content: "OK" },
            },
          ],
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const kb = (await (
    await request.post("/api/knowledge-bases", {
      data: { name: `配置生效验收 ${Date.now()}` },
    })
  ).json()) as { id: string };
  const key = "synthetic-browser-test-secret";
  const chatModel = page.getByRole("region", { name: "聊天模型", exact: true });
  const vectorModel = page.getByRole("region", {
    name: "向量模型",
    exact: true,
  });
  try {
    await page.goto(`/settings?kb=${kb.id}`);
    await page.getByRole("button", { name: "模型连接", exact: true }).click();
    await chatModel.getByLabel("服务地址", { exact: true }).fill(baseUrl);
    await chatModel
      .getByLabel("模型名称", { exact: true })
      .fill("http-test-chat");
    await chatModel.getByLabel("API 密钥", { exact: true }).fill(key);
    await page
      .getByRole("button", { name: "测试聊天连接", exact: true })
      .click();
    await expect(chatModel.locator(".zc-probe-result").first()).toContainText(
      "测试通过",
    );
    await page
      .getByRole("button", { name: "测试工具调用", exact: true })
      .click();
    await expect(chatModel.locator(".zc-probe-result").last()).toContainText(
      "测试通过",
    );
    expect(
      (
        (await (
          await request.get("/api/settings/config")
        ).json()) as RuntimeConfig
      ).revision,
    ).toBe(initial.revision);
    await vectorModel.getByLabel("服务地址", { exact: true }).fill(baseUrl);
    await vectorModel
      .getByLabel("模型名称", { exact: true })
      .fill("http-test-vector-v1");
    await vectorModel.getByLabel("API 密钥", { exact: true }).fill(key);
    await vectorModel.getByLabel("向量维度", { exact: true }).fill("3");
    await page
      .getByRole("button", { name: "测试向量连接", exact: true })
      .click();
    await expect(vectorModel.locator(".zc-probe-result")).toContainText(
      "测试通过",
    );
    await page.getByRole("button", { name: "知识处理", exact: true }).click();
    await page.getByLabel("切块长度（Token）", { exact: true }).fill("128");
    await page.getByLabel("切块重叠（Token）", { exact: true }).fill("10");
    await page.getByLabel("向量批处理大小", { exact: true }).fill("1");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    const saved = (await (
      await request.get("/api/settings/config")
    ).json()) as RuntimeConfig;
    expect(saved.revision).toBe(initial.revision + 1);
    expect(
      saved.llm.api_key_configured && saved.embedding.api_key_configured,
    ).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain(key);
    await page.reload();
    await page.getByRole("button", { name: "模型连接", exact: true }).click();
    await expect(chatModel.getByLabel("API 密钥", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      chatModel.getByText("已配置密钥", { exact: true }),
    ).toBeVisible();
    await chatModel
      .getByLabel("模型名称", { exact: true })
      .fill("http-test-chat-v2");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "测试聊天连接", exact: true })
      .click();
    await expect
      .poll(
        () =>
          calls.filter(
            (call) =>
              call.model === "http-test-chat-v2" &&
              call.authorization === `Bearer ${key}`,
          ).length,
      )
      .toBe(1);
    await chatModel.getByLabel("保存时清除现有密钥", { exact: true }).check();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(
      chatModel.getByText("未配置密钥", { exact: true }),
    ).toBeVisible();
    await vectorModel
      .getByLabel("模型名称", { exact: true })
      .fill("http-test-vector-v2");
    const latest = (await (
      await request.get("/api/settings/config")
    ).json()) as RuntimeConfig;
    const external = await request.put("/api/settings/config", {
      data: { revision: latest.revision, processing: { summary_max_calls: 7 } },
    });
    expect(external.ok()).toBeTruthy();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("其他窗口更新");
    await expect(
      vectorModel.getByLabel("模型名称", { exact: true }),
    ).toHaveValue("http-test-vector-v2");
    await page
      .getByRole("button", { name: "重新读取最新设置", exact: true })
      .click();
    await page
      .getByRole("button", { name: "放弃草稿并重新读取", exact: true })
      .click();
    await expect(
      vectorModel.getByLabel("模型名称", { exact: true }),
    ).toHaveValue("http-test-vector-v1");
    await vectorModel
      .getByLabel("模型名称", { exact: true })
      .fill("http-test-vector-v2");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    expect(storage).not.toContain(key);
    const peer = await context.newPage();
    await peer.goto(`/settings?kb=${kb.id}`);
    await peer.getByRole("button", { name: "模型连接", exact: true }).click();
    await expect(
      peer
        .getByRole("region", { name: "向量模型", exact: true })
        .getByLabel("模型名称", { exact: true }),
    ).toHaveValue("http-test-vector-v2");
    await peer.close();
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await page.getByRole("button", { name: "浏览资料", exact: true }).click();
    const filename = `热刷新验收-${Date.now()}.txt`;
    await page.getByLabel("上传文档", { exact: true }).setInputFiles({
      name: filename,
      mimeType: "text/plain",
      buffer: Buffer.from(
        "知识配置生效验证，真实文件切块和向量写入。".repeat(120),
      ),
    });
    const row = page.locator(".document-row").filter({ hasText: filename });
    await expect(row.getByText("已就绪", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect
      .poll(
        () =>
          calls.filter((call) => call.model === "http-test-vector-v2").length,
        { timeout: 30000 },
      )
      .toBeGreaterThan(2);
    expect(
      calls
        .filter((call) => call.model === "http-test-vector-v2")
        .every(
          (call) => call.count === 1 && call.authorization === `Bearer ${key}`,
        ),
    ).toBeTruthy();
    await expect
      .poll(
        async () => {
          const items = (await (
            await request.get(`/api/ingestion/jobs?kb_id=${kb.id}`)
          ).json()) as JobState[];
          return items[0]?.status;
        },
        { timeout: 30000 },
      )
      .toBe("partial_ready");
    const status = (await (
      await request.get("/api/settings/model-status")
    ).json()) as {
      embedding: { model: string; dimension: number; configured: boolean };
    };
    expect(status.embedding).toMatchObject({
      model: "http-test-vector-v2",
      dimension: 3,
      configured: true,
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型连接", exact: true }).click();
    await chatModel.getByLabel("API 密钥", { exact: true }).fill(key);
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText("修改已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await page
      .getByRole("textbox", { name: "知识库问题" })
      .fill("知识配置如何生效？");
    await page.getByRole("button", { name: "发送问题", exact: true }).click();
    await expect(page.locator(".message-assistant").last()).toContainText(
      "受控HTTP回答",
    );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "外观与布局" }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const items = (await (
            await request.get(`/api/ingestion/jobs?kb_id=${kb.id}`)
          ).json()) as JobState[];
          return items.find((job) => job.kind === "chat")?.status;
        },
        { timeout: 15000 },
      )
      .toBe("completed");
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await expect(page.locator(".message-assistant").last()).toContainText(
      "来源可追溯",
    );
    await expect(page.locator(".citations button")).toHaveCount(1);
    await page.locator(".citations button").click();
    await expect(page.locator(".citation-banner")).toContainText("第 1 行");
    await expect(page.locator(".text-reader")).toContainText(
      "知识配置生效验证",
    );
  } finally {
    const latest = (await (
      await request.get("/api/settings/config")
    ).json()) as RuntimeConfig;
    const draft = configDraft(initial);
    const restore = await request.put("/api/settings/config", {
      data: {
        revision: latest.revision,
        ...draft,
        llm: { ...draft.llm, clear_api_key: true },
        embedding: { ...draft.embedding, clear_api_key: true },
      },
    });
    expect(restore.ok()).toBeTruthy();
    await request.delete(`/api/knowledge-bases/${kb.id}`);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
