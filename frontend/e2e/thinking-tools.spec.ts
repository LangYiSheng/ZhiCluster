import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { waitForParsed } from "./helpers";

type Row = Record<string, unknown>;
type ProviderMessage = { role: string; content?: string; tool_call_id?: string };
type ProviderBody = {
  stream?: boolean;
  tools?: { function: { name: string } }[];
  messages?: ProviderMessage[];
  response_format?: unknown;
};
type ToolCall = { tool: string; arguments: Row };
type Step = { stage: string; tool_name?: string; status: string; source?: Row; [key: string]: unknown };
type Answer = { id: string; role: string; status: string; content: string; citations?: Row[]; retrieval?: { execution?: Step[]; tool_usage?: Row; retrieval_strategy?: string } };

async function checked<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

function feedback(messages: ProviderMessage[]): Row[] {
  return messages.flatMap((message) => {
    if (message.role === "tool") return [JSON.parse(message.content || "{}") as Row];
    const match = message.content?.match(/<source_data>\s*([\s\S]*?)\s*<\/source_data>/);
    if (!match || message.role !== "user") return [];
    const decoded: unknown = JSON.parse(match[1]);
    return Array.isArray(decoded) ? decoded as Row[] : [];
  });
}

for (const native of [true, false]) {
  test(`思考工具真实入库、读取与溯源，${native ? "原生工具" : "JSON兼容"}及快速模式对照`, async ({ page, request }, testInfo) => {
    test.setTimeout(150000);
    page.setDefaultTimeout(10000);
    const target = new URL(String(testInfo.project.use.baseURL));
    test.skip(process.env.E2E_CONFIG_WRITES !== "1" || !["localhost", "127.0.0.1"].includes(target.hostname) || target.port !== "13002", "仅允许显式启用的13002独立验收站点");
    const initial = await checked<{ revision: number; llm: Row; embedding: Row; processing: Row }>(await request.get("/api/settings/config"));
    test.skip(Boolean(initial.llm.api_key_configured || initial.embedding.api_key_configured), "保留已有模型密钥，不覆盖非空站点");
    const fixtureName = "推免名额说明.md";
    const calls: { planner: boolean; body: ProviderBody }[] = [];
    const planned: ToolCall[] = [];
    const errors: string[] = [];
    let turn = 0;
    const server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw) as ProviderBody;
        const messages = body.messages || [];
        const planner = messages.some((message) => message.content?.includes("<scope_data>"));
        calls.push({ planner, body });
        let content = "";
        let selected: ToolCall[] = [];
        if (planner) {
          turn++;
          const results = feedback(messages);
          if (turn === 1) {
            selected = [
              { tool: "get_current_scope", arguments: {} },
              { tool: "list_scope_metadata", arguments: { kind: "folders" } },
              { tool: "list_documents", arguments: { query: "推免名额" } },
            ];
          } else if (turn === 2) {
            const documents = results.find((result) => result.kind === "documents");
            const document = (documents?.items as Row[] | undefined)?.find((item) => item.document_name === fixtureName);
            if (!document) throw new Error("文档列表没有返回真实范围内文档");
            selected = [
              { tool: "search_knowledge", arguments: { query: "普通推免 专项推免 名额" } },
              { tool: "get_document_outline", arguments: { document_id: document.document_id } },
            ];
          } else if (turn === 3) {
            const outline = results.find((result) => result.kind === "document_outline");
            const section = (outline?.items as Row[] | undefined)?.find((item) => String(item.heading).includes("名额分配"));
            if (!outline || !section) throw new Error("目录工具没有返回真实章节");
            selected = [{ tool: "read_document", arguments: { document_id: outline.document_id, section_ids: [section.section_id], limit: 4 } }];
          } else if (turn !== 4) throw new Error("规划超出预期回合");
          planned.push(...selected);
          content = native ? "PLANNING_PRIVATE_SENTINEL 不应进入答案或公开过程" : JSON.stringify({ tools: selected });
        } else if (body.response_format) {
          content = JSON.stringify({ summary: { short_summary: "推免名额安排", detailed_summary: "说明普通和专项名额分配。", keywords: ["推免", "名额"], main_topics: ["名额安排"] }, classification: { existing_tag_ids: [], new_tag_names: [], short_summary: "推免资料", reason: "受控验收", confidence_hint: "受控验收" } });
        } else {
          const context = messages.find((message) => message.content?.includes("<source_data>"))?.content || "";
          if (context.includes("OUTSIDE_SCOPE_SENTINEL")) throw new Error("最终证据包含范围外资料");
          const blocks = [...context.matchAll(/\[S(\d+)\] ([^\n]+)\n([\s\S]*?)(?=\[S\d+\]|<\/source_data>)/g)];
          const source = blocks.find((block) => block[3].includes("89"));
          if (!source) throw new Error("最终证据没有实际名额正文");
          content = `普通推免89人，专项推免16人，合计105人。[S${source[1]}]`;
        }
        const toolCalls = native && planner ? selected.map((call, index) => ({ id: `turn-${turn}-${index}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.arguments) } })) : [];
        if (body.stream) {
          res.setHeader("Content-Type", "text/event-stream");
          for (const token of [content.slice(0, 10), content.slice(10)]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }] }));
        }
      } catch (error) {
        errors.push(String(error));
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "受控验收服务失败" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const providerUrl = `http://host.docker.internal:${(server.address() as AddressInfo).port}/v1`;
    let kbId = "";
    let changed = false;
    const out = path.resolve(`../.data/test-runs/thinking-tools/${native ? "native" : "json"}`);
    await mkdir(out, { recursive: true });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await checked(await request.put("/api/settings/config", { data: { revision: initial.revision, llm: { base_url: providerUrl, api_key: "synthetic-thinking-tools-key", model: "thinking-test", models: ["thinking-test"], supports_tools: native }, embedding: { base_url: "", model: "", clear_api_key: true } } }));
      changed = true;
      kbId = (await checked<{ id: string }>(await request.post("/api/knowledge-bases", { data: { name: `思考工具验收${native ? "原生" : "JSON"}` } }))).id;
      const focus = await checked<{ id: string }>(await request.post(`/api/knowledge-bases/${kbId}/folders`, { data: { name: "政策资料" } }));
      const outside = await checked<{ id: string }>(await request.post(`/api/knowledge-bases/${kbId}/folders`, { data: { name: "范围外" } }));
      for (const [index, name] of [fixtureName, "范围外对照.md"].entries()) {
        await checked(await request.post(`/api/knowledge-bases/${kbId}/uploads`, { multipart: { folder_id: index === 0 ? focus.id : outside.id, files: { name, mimeType: "text/markdown", buffer: Buffer.from(index === 0 ? "# 推免安排\n\n本资料供演示核对名额分配。\n\n## 名额分配\n\n普通推免89人，专项推免16人，合计105人。所有数字均来自本段。\n\n## 提交要求\n\n请按通知提交材料。" : "# 范围外\n\nOUTSIDE_SCOPE_SENTINEL 普通推免999人，不得进入当前范围的工具结果。") } } }));
      }
      await waitForParsed(request, kbId, [fixtureName, "范围外对照.md"]);
      const conversation = await checked<{ id: string }>(await request.post("/api/conversations", { data: { kb_id: kbId, title: "核对推免名额", scope: { kb_ids: [kbId], folder_ids: [focus.id], include_descendants: false } } }));
      await page.goto(`/chat?kb=${kbId}`);
      await page.getByRole("button", { name: "历史对话", exact: true }).click();
      await page.getByRole("button", { name: "打开对话：核对推免名额", exact: true }).click();
      await page.getByRole("button", { name: "选择模型与思考模式", exact: true }).click();
      await page.getByRole("button", { name: "思考", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("textbox", { name: "知识库问题" }).fill("请查找推免名额资料，查看目录并阅读名额分配原文后，告诉我普通、专项和合计名额。");
      await page.getByRole("button", { name: "发送问题", exact: true }).click();
      await expect.poll(async () => (await checked<Answer[]>(await request.get(`/api/conversations/${conversation.id}/messages`))).find((message) => message.role === "assistant")?.status, { timeout: 60000 }).toBe("completed");
      const answer = (await checked<Answer[]>(await request.get(`/api/conversations/${conversation.id}/messages`))).find((message) => message.role === "assistant")!;
      expect(answer.content).toContain("合计105人");
      expect(answer.content).not.toContain("PLANNING_PRIVATE_SENTINEL");
      const activities = (answer.retrieval?.execution || []).filter((step) => step.stage === "tool_activity" && step.status === "completed");
      expect(new Set(activities.map((step) => step.tool_name))).toEqual(new Set(["get_current_scope", "list_scope_metadata", "list_documents", "search_knowledge", "get_document_outline", "read_document"]));
      expect(answer.retrieval?.tool_usage?.document_calls).toBe(3);
      expect(JSON.stringify(answer.retrieval)).not.toMatch(/_source_scopes|OUTSIDE_SCOPE_SENTINEL/);
      const replay = await request.get(`/api/conversations/${conversation.id}/events`, { timeout: 15000 });
      expect(replay.ok()).toBe(true);
      const replayText = await replay.text();
      expect(replayText).toContain("tool_activity");
      expect(replayText).not.toMatch(/_source_scopes|_activity_scope|PLANNING_PRIVATE_SENTINEL|OUTSIDE_SCOPE_SENTINEL/);
      const progress = page.locator(".chat-progress").last();
      await expect(page.locator(".message-assistant .markdown").last()).toContainText("合计105人");
      await expect(progress.locator(":scope > summary")).toContainText("已完成");
      await expect(progress).not.toHaveAttribute("open");
      await progress.locator(":scope > summary").click();
      await expect(progress).toContainText(fixtureName);
      await expect(progress.locator(".chat-tool-activity")).toHaveCount(6);
      await page.screenshot({ path: path.join(out, "thinking-desktop.png"), fullPage: true });
      const readStep = progress.locator(".chat-tool-activity").filter({ hasText: /阅读/ }).last();
      const sourceButton = readStep.getByRole("button", { name: new RegExp(fixtureName.replace(".", "\\.")) });
      await expect(sourceButton).toBeVisible();
      await sourceButton.click();
      await expect(page.locator(".reference-pane")).toContainText("89人");
      await page.screenshot({ path: path.join(out, "thinking-source.png"), fullPage: true });
      await page.getByRole("button", { name: "关闭参考资料", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => Math.round((await page.locator(".workspace").boundingBox())!.width)).toBeGreaterThanOrEqual(330);
      await expect.poll(async () => Math.round((await page.locator(".chat-messages").boundingBox())!.width)).toBeGreaterThanOrEqual(330);
      await expect(page.locator(".reference-pane")).toHaveCSS("visibility", "hidden");
      await expect(page.locator(".reference-pane")).toHaveCSS("opacity", "0");
      await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect.poll(async () => Math.round((await page.locator(".message-assistant .message-body").last().boundingBox())!.width)).toBeGreaterThanOrEqual(240);
      await page.screenshot({ path: path.join(out, "thinking-mobile.png"), fullPage: true });
      await page.reload();
      await page.getByRole("button", { name: "历史对话", exact: true }).click();
      await page.getByRole("button", { name: "打开对话：核对推免名额", exact: true }).click();
      await expect(page.locator(".message-assistant .markdown").last()).toContainText("合计105人");
      const refreshed = page.locator(".chat-progress").last();
      await refreshed.locator(":scope > summary").click();
      await expect(refreshed.locator(".chat-tool-activity")).toHaveCount(6);
      const beforeQuick = calls.filter((call) => call.planner).length;
      await checked(await request.post(`/api/conversations/${conversation.id}/messages`, { data: { content: "普通推免和专项推免的名额合计是多少？", retrieval_mode: "direct" } }));
      await expect.poll(async () => (await checked<Answer[]>(await request.get(`/api/conversations/${conversation.id}/messages`))).filter((message) => message.role === "assistant").at(-1)?.status, { timeout: 45000 }).toBe("completed");
      expect(calls.filter((call) => call.planner)).toHaveLength(beforeQuick);
      const quick = (await checked<Answer[]>(await request.get(`/api/conversations/${conversation.id}/messages`))).filter((message) => message.role === "assistant").at(-1)!;
      expect(quick.content).toContain("合计105人");
      expect(new Set(quick.retrieval?.execution?.filter((step) => step.stage === "tool_activity").map((step) => step.tool_name))).toEqual(new Set(["search_knowledge"]));
      expect(errors).toEqual([]);
      expect(pageErrors).toEqual([]);
      await writeFile(path.join(out, "results.json"), JSON.stringify({ passed: true, native, answer, quick, planned, providerRequests: calls.length, pageErrors, errors }, null, 2));
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (kbId) await request.delete(`/api/knowledge-bases/${kbId}`);
      if (changed) {
        const current = await checked<{ revision: number }>(await request.get("/api/settings/config"));
        const { api_key_configured: savedLlm, ...llm } = initial.llm;
        const { api_key_configured: savedEmbedding, ...embedding } = initial.embedding;
        void savedLlm;
        void savedEmbedding;
        await checked(await request.put("/api/settings/config", { data: { revision: current.revision, llm: { ...llm, clear_api_key: true }, embedding: { ...embedding, clear_api_key: true }, processing: initial.processing } }));
      }
      await writeFile(path.join(out, "provider-requests.json"), JSON.stringify(calls, null, 2));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
