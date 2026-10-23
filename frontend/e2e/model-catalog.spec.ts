import { test, expect, type Locator } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RuntimeConfig } from "../src/lib/settings";

test("真实 HTTP 获取模型列表：聊天向量独立选择、失败回退且不保存草稿", async ({
  page,
  request,
}) => {
  const before = (await (
    await request.get("/api/settings/config")
  ).json()) as RuntimeConfig;
  // Only the configuration view is controlled: avoid auto-fetching a real saved
  // provider. Discovery itself uses the actual backend and a local HTTP service.
  await page.route("**/api/settings/config", (route) =>
    route.fulfill({
      json: {
        ...before,
        llm: {
          ...before.llm,
          base_url: "",
          model: "",
          api_key_configured: false,
        },
        embedding: {
          ...before.embedding,
          base_url: "",
          model: "",
          api_key_configured: false,
        },
      },
    }),
  );
  const calls: { path: string; method: string; authorization: string }[] = [];
  const chatKey = "synthetic-chat-catalog";
  const vectorKey = "synthetic-vector-catalog";
  const server = createServer((req, res) => {
    calls.push({
      path: req.url || "",
      method: req.method || "",
      authorization: req.headers.authorization || "",
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/unsupported/v1/models") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `fixture upstream body ${chatKey}` }));
    } else if (req.url === "/denied/v1/models") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: `fixture upstream body ${chatKey}` }));
    } else {
      const ids =
        req.headers.authorization === `Bearer ${chatKey}`
          ? ["catalog-chat-alpha", "catalog-chat-beta"]
          : ["catalog-vector-small", "catalog-vector-large"];
      res.end(
        JSON.stringify({
          object: "list",
          data: ids.map((id) => ({ id, object: "model" })),
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const host = process.env.E2E_PROVIDER_HOST || "host.docker.internal";
  const origin = `http://${host}:${(server.address() as AddressInfo).port}`;
  const chat = page.getByRole("region", { name: "聊天模型", exact: true });
  const vector = page.getByRole("region", { name: "向量模型", exact: true });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  async function choose(region: Locator, model: string) {
    await region
      .getByRole("combobox", { name: "模型名称", exact: true })
      .click();
    await page.getByRole("option", { name: model, exact: true }).click();
  }
  try {
    await page.goto("/settings?section=models");
    await chat
      .getByLabel("服务地址", { exact: true })
      .fill(`${origin}/chat/v1`);
    await chat.getByLabel("API 密钥", { exact: true }).fill(chatKey);
    await expect(chat).toContainText("已获取 2 个模型");
    await expect(vector).not.toContainText("已获取 2 个模型");
    await choose(chat, "catalog-chat-beta");
    await vector
      .getByLabel("服务地址", { exact: true })
      .fill(`${origin}/vector/v1`);
    await vector.getByLabel("API 密钥", { exact: true }).fill(vectorKey);
    await expect(vector).toContainText("已获取 2 个模型");
    await choose(vector, "catalog-vector-small");
    await expect(
      chat.getByRole("combobox", { name: "模型名称", exact: true }),
    ).toContainText("catalog-chat-beta");
    expect(calls.filter((call) => call.path === "/chat/v1/models")).toEqual([
      {
        path: "/chat/v1/models",
        method: "GET",
        authorization: `Bearer ${chatKey}`,
      },
    ]);
    expect(calls.filter((call) => call.path === "/vector/v1/models")).toEqual([
      {
        path: "/vector/v1/models",
        method: "GET",
        authorization: `Bearer ${vectorKey}`,
      },
    ]);
    await chat.getByRole("combobox", { name: "模型名称", exact: true }).click();
    await page.screenshot({
      path: "test-results/model-catalog-desktop.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await chat
      .getByLabel("服务地址", { exact: true })
      .fill(`${origin}/unsupported/v1`);
    await expect(chat).toContainText("此服务未提供模型列表接口");
    await expect(chat).not.toContainText("已获取 2 个模型");
    await expect(
      chat.getByRole("combobox", { name: "模型名称", exact: true }),
    ).toContainText("catalog-chat-beta");
    await chat.getByRole("button", { name: "手动填写", exact: true }).click();
    await expect(
      chat.getByRole("textbox", { name: "模型名称", exact: true }),
    ).toHaveValue("catalog-chat-beta");
    await chat
      .getByRole("textbox", { name: "模型名称", exact: true })
      .fill("manual-provider-model");
    await chat
      .getByLabel("服务地址", { exact: true })
      .fill(`${origin}/denied/v1`);
    await expect(chat).toContainText("API 密钥无效或没有访问权限");
    expect(await page.locator("body").innerText()).not.toContain(chatKey);
    await expect(
      vector.getByRole("combobox", { name: "模型名称", exact: true }),
    ).toContainText("catalog-vector-small");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: "test-results/model-catalog-mobile.png",
      fullPage: true,
    });
    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    expect(storage).not.toContain(chatKey);
    expect(storage).not.toContain(vectorKey);
    const after = await (await request.get("/api/settings/config")).json();
    expect(after).toEqual(before);
    expect(pageErrors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
