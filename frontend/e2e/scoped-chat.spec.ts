import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { waitForParsed } from "./helpers";

type ProviderMessage = {
  role: string;
  content: string;
  tool_call_id?: string;
};
type ProviderBody = {
  model: string;
  stream?: boolean;
  tools?: { function: { name: string } }[];
  messages?: ProviderMessage[];
  response_format?: unknown;
  input?: string[];
};
type MetadataItem = { id: string; name: string; kb_id?: string };
type ToolResult = {
  kind?: string;
  items?: MetadataItem[];
  knowledge_bases?: MetadataItem[];
  selected_folders?: MetadataItem[];
  source_count?: number;
  sources?: { document_name: string; snippet: string }[];
};
type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type ExecutionStep = {
  stage: string;
  round?: number;
  scope_key?: string;
  scope_label?: string;
  query?: string;
  queries?: string[];
  source_count?: number;
  status: string;
};
type ChatMessage = {
  id: string;
  role: string;
  status: string;
  content: string;
  citations?: { document_id: string; chunk_id: string; ordinal: number }[];
  retrieval?: { execution?: ExecutionStep[]; tool_usage?: unknown };
};

async function checked<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("真实范围元数据、同轮双查询与次轮标签交集，经worker和SSE显示真实来源", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const target = new URL(String(testInfo.project.use.baseURL));
  test.skip(
    process.env.E2E_CONFIG_WRITES !== "1" ||
      !["127.0.0.1", "localhost"].includes(target.hostname) ||
      target.port !== "13001",
    "仅显式启用的13001隔离站点允许修改合成模型配置",
  );
  const initial = await checked<{
    revision: number;
    llm: { api_key_configured: boolean } & Record<string, unknown>;
    embedding: { api_key_configured: boolean } & Record<string, unknown>;
    processing: Record<string, unknown>;
  }>(await request.get("/api/settings/config"));
  test.skip(
    initial.llm.api_key_configured || initial.embedding.api_key_configured,
    "隔离站点已有模型密钥，保留原配置并跳过",
  );

  const out = path.resolve("../.data/test-runs/review-scope-ui/scoped-browser");
  await mkdir(out, { recursive: true });
  const calls: { url: string; body: ProviderBody }[] = [];
  const chosenFilters: {
    turn: number;
    tool: string;
    arguments: Record<string, unknown>;
  }[] = [];
  const serverErrors: string[] = [];
  let nativeTurn = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/v1/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            data: [{ id: "scoped-chat" }, { id: "scoped-embed" }],
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as ProviderBody;
      calls.push({ url: req.url || "", body });
      if (req.url === "/v1/embeddings") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            data: (body.input || []).map((_, index) => ({
              index,
              embedding: [1, 0, 0],
            })),
          }),
        );
        return;
      }
      if (body.response_format) {
        // Ingestion returns the current combined schema: classification suggests tags only.
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: {
                      short_summary: "operator与comparison资料",
                      detailed_summary:
                        "资料说明operator与comparison的含义和用法。",
                      keywords: ["operator", "comparison"],
                      main_topics: ["运算符"],
                    },
                    classification: {
                      existing_tag_ids: [],
                      new_tag_names: [],
                      short_summary: "关系运算符资料",
                      reason: "保留用户已有标签",
                      confidence_hint: "受控验收建议",
                    },
                  }),
                },
              },
            ],
          }),
        );
        return;
      }
      const toolCalls: ToolCall[] = [];
      const addCall = (name: string, arguments_: Record<string, unknown>) => {
        chosenFilters.push({
          turn: nativeTurn,
          tool: name,
          arguments: arguments_,
        });
        toolCalls.push({
          id: `scope-turn-${nativeTurn}-${toolCalls.length}`,
          type: "function",
          function: { name, arguments: JSON.stringify(arguments_) },
        });
      };
      let content =
        "operator用于表示运算；comparison描述比较两个值的关系。[S1] 两份资料都给出了比较条件的说明。[S2]";
      if (
        body.tools?.some((tool) => tool.function.name === "search_knowledge")
      ) {
        nativeTurn++;
        const snapshotText =
          body.messages?.find((message) =>
            message.content?.includes("<scope_data>"),
          )?.content || "";
        const snapshot = JSON.parse(
          snapshotText.split("<scope_data>")[1].split("</scope_data>")[0],
        ) as ToolResult;
        const results = (body.messages || [])
          .filter((message) => message.role === "tool")
          .map((message) => JSON.parse(message.content) as ToolResult);
        const kbId = snapshot.knowledge_bases?.[0]?.id;
        if (!kbId)
          throw new Error("Planner did not receive actual scope metadata");
        if (nativeTurn === 1) {
          content = "我先确认当前资料范围。";
          addCall("get_current_scope", {});
          addCall("list_scope_metadata", { kind: "folders", kb_id: kbId });
        } else {
          const folder = results
            .find((result) => result.kind === "folders")
            ?.items?.find((item) => item.name === "focus");
          if (!folder)
            throw new Error("Planner did not receive the allowed folder ID");
          if (nativeTurn === 2) {
            content = "接下来查阅operator和comparison。";
            addCall("search_knowledge", {
              query: "operator",
              kb_ids: [kbId],
              folder_ids: [folder.id],
              include_descendants: false,
            });
            addCall("search_knowledge", {
              query: "comparison",
              kb_ids: [kbId],
              folder_ids: [folder.id],
              include_descendants: false,
            });
            addCall("list_scope_metadata", { kind: "tags", kb_id: kbId });
          } else if (nativeTurn === 3) {
            const tag = results
              .find((result) => result.kind === "tags")
              ?.items?.find((item) => item.name === "重点");
            if (!tag)
              throw new Error(
                "Planner did not receive the tag ID from metadata",
              );
            content = "再按重点标签核对comparison。";
            addCall("search_knowledge", {
              query: "comparison",
              kb_ids: [kbId],
              folder_ids: [folder.id],
              include_descendants: false,
              tag_ids: [tag.id],
              tag_match: "all",
            });
          } else throw new Error("Unexpected extra planning turn");
        }
      }
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        );
        if (toolCalls.length)
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) } }] })}\n\n`,
          );
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content,
                  ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: toolCalls.length ? "tool_calls" : "stop",
              },
            ],
          }),
        );
      }
    } catch (error) {
      serverErrors.push(String(error));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Synthetic scoped model failed" } }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const url = `http://host.docker.internal:${(server.address() as AddressInfo).port}/v1`;
  let kbId = "";
  let conversationId = "";
  let configurationChanged = false;
  let evidence: Record<string, unknown> = {};
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const captured: { type: string; data: Record<string, unknown> }[] = [];
    Object.assign(window, { __scopedChatEvents: captured });
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        for (const type of [
          "status",
          "progress",
          "token",
          "citation",
          "completed",
          "error",
        ])
          this.addEventListener(type, (event) => {
            const data = (event as MessageEvent<string>).data;
            // Native reconnect/error events have no data; only observe SSE payloads.
            if (typeof data === "string")
              captured.push({ type, data: JSON.parse(data) });
          });
      }
    };
  });
  try {
    await checked(
      await request.put("/api/settings/config", {
        data: {
          revision: initial.revision,
          llm: {
            base_url: url,
            api_key: "synthetic-scoped-chat-key",
            model: "scoped-chat",
            models: ["scoped-chat"],
            supports_tools: true,
          },
          embedding: {
            base_url: url,
            api_key: "synthetic-scoped-embed-key",
            model: "scoped-embed",
            dimension: 3,
          },
        },
      }),
    );
    configurationChanged = true;
    const kb = await checked<{ id: string }>(
      await request.post("/api/knowledge-bases", {
        data: { name: `范围检索验收 ${Date.now()}` },
      }),
    );
    kbId = kb.id;
    const focus = await checked<{ id: string }>(
      await request.post(`/api/knowledge-bases/${kbId}/folders`, {
        data: { name: "focus" },
      }),
    );
    const outside = await checked<{ id: string }>(
      await request.post(`/api/knowledge-bases/${kbId}/folders`, {
        data: { name: "outside" },
      }),
    );
    const tag = await checked<{ id: string }>(
      await request.post(`/api/knowledge-bases/${kbId}/tags`, {
        data: { name: "重点", color: "#3f6b50", aliases: [] },
      }),
    );
    const fixtureNames = [
      "operator-guide.txt",
      "comparison-notes.txt",
      "outside-control.txt",
    ];
    const uploadIds: string[] = [];
    for (const [index, name] of fixtureNames.entries()) {
      const upload = await checked<{
        items: { document: { id: string }; status: string }[];
      }>(
        await request.post(`/api/knowledge-bases/${kbId}/uploads`, {
          multipart: {
            folder_id: index < 2 ? focus.id : outside.id,
            files: {
              name,
              mimeType: "text/plain",
              buffer: Buffer.from(
                index === 0
                  ? "operator comparison：operator表示运算符，comparison比较两个值，返回真或假。"
                  : index === 1
                    ? "comparison operator：comparison关系比较包含大于、小于、等于；operator运算符用于条件判断。"
                    : "operator comparison OUTSIDE_SCOPE_CONTROL：这份范围外资料绝不能进入回答或引用。",
              ),
            },
          },
        }),
      );
      expect(upload.items[0].status).toBe("queued");
      uploadIds.push(upload.items[0].document.id);
    }
    await waitForParsed(request, kbId, fixtureNames);
    await expect
      .poll(
        async () => {
          const result = await checked<{
            items: {
              index_status: string;
              summary_status: string;
              classification_status: string;
            }[];
          }>(await request.get(`/api/knowledge-bases/${kbId}/documents`));
          return result.items.filter((document) =>
            [
              document.index_status,
              document.summary_status,
              document.classification_status,
            ].every((status) => status === "ready"),
          ).length;
        },
        { timeout: 45000 },
      )
      .toBe(3);
    for (const documentId of uploadIds.slice(0, 2)) {
      const document = await checked<{ version: number }>(
        await request.get(`/api/documents/${documentId}`),
      );
      await checked(
        await request.patch(`/api/documents/${documentId}`, {
          data: { version: document.version, tag_ids: [tag.id] },
        }),
      );
    }
    const conversation = await checked<{ id: string }>(
      await request.post("/api/conversations", {
        data: {
          kb_id: kbId,
          title: "范围与两轮检索",
          scope: {
            kb_ids: [kbId],
            folder_ids: [focus.id],
            include_descendants: false,
          },
        },
      }),
    );
    conversationId = conversation.id;
    await page.goto(`/chat?kb=${kbId}`);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("button", { name: "打开对话：范围与两轮检索", exact: true })
      .click();
    await page
      .getByRole("button", { name: "选择模型与思考模式", exact: true })
      .click();
    await page.getByRole("button", { name: "思考", exact: true }).click();
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "知识库问题" })
      .fill(
        "请在focus目录查阅operator和comparison，并用重点标签再次核对comparison。",
      );
    await page.getByRole("button", { name: "发送问题", exact: true }).click();
    const markdown = page.locator(".message-assistant .markdown").last();
    await expect(markdown).toContainText("两份资料都给出了比较条件", {
      timeout: 45000,
    });
    await expect
      .poll(
        async () =>
          (
            await checked<ChatMessage[]>(
              await request.get(
                `/api/conversations/${conversationId}/messages`,
              ),
            )
          ).find((message) => message.role === "assistant")?.status,
      )
      .toBe("completed");
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as Window & { __scopedChatEvents?: { type: string }[] }
            ).__scopedChatEvents?.some((event) => event.type === "completed") ||
            false,
        ),
      )
      .toBe(true);
    const messages = await checked<ChatMessage[]>(
      await request.get(`/api/conversations/${conversationId}/messages`),
    );
    const answer = messages.find((message) => message.role === "assistant")!;
    const summaries = (answer.retrieval?.execution || []).filter(
      (step) => step.stage === "search_round_summary",
    );
    expect(new Set(summaries.map((step) => step.round))).toEqual(
      new Set([1, 2]),
    );
    const roundOne = summaries.filter((step) => step.round === 1).at(-1)!;
    const roundTwo = summaries.filter((step) => step.round === 2).at(-1)!;
    expect(roundOne.queries).toEqual(["operator", "comparison"]);
    expect(roundTwo.queries).toEqual(["comparison"]);
    expect(roundOne.scope_key).not.toBe(roundTwo.scope_key);
    expect(roundOne.source_count).toBe(2);
    expect(roundTwo.source_count).toBe(2);
    expect(answer.citations).toHaveLength(2);
    expect(
      new Set(answer.citations!.map((citation) => citation.document_id)),
    ).toEqual(new Set(uploadIds.slice(0, 2)));
    expect(answer.citations!.every((citation) => !!citation.chunk_id)).toBe(
      true,
    );
    const plannerCalls = calls.filter((call) =>
      call.body.tools?.some(
        (tool) => tool.function.name === "search_knowledge",
      ),
    );
    expect(plannerCalls).toHaveLength(3);
    expect(
      plannerCalls[0].body.messages?.some((message) =>
        message.content.includes(focus.id),
      ),
    ).toBe(true);
    const folderResult = (plannerCalls[1].body.messages || [])
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(message.content) as ToolResult)
      .find((result) => result.kind === "folders");
    expect(folderResult?.items?.map((item) => item.id)).toEqual([focus.id]);
    const searches = chosenFilters.filter(
      (call) => call.tool === "search_knowledge",
    );
    expect(searches).toHaveLength(3);
    expect(searches[1].arguments.query).toBe(searches[2].arguments.query);
    expect(searches[2].arguments).toMatchObject({
      folder_ids: [focus.id],
      tag_ids: [tag.id],
      tag_match: "all",
    });
    const toolSources = plannerCalls.flatMap((call) =>
      (call.body.messages || [])
        .filter((message) => message.role === "tool")
        .map((message) => JSON.parse(message.content) as ToolResult)
        .flatMap((result) => result.sources || []),
    );
    expect(toolSources.length).toBeGreaterThan(0);
    expect(
      toolSources.every((source) =>
        fixtureNames.slice(0, 2).includes(source.document_name),
      ),
    ).toBe(true);
    const finalCall = calls
      .filter((call) => call.body.stream && !call.body.tools)
      .at(-1)!;
    const contextText =
      finalCall.body.messages?.find((message) =>
        message.content.includes("<source_data>"),
      )?.content || "";
    expect(contextText).toContain("operator-guide.txt");
    expect(contextText).toContain("comparison-notes.txt");
    expect(contextText).not.toContain("OUTSIDE_SCOPE_CONTROL");
    expect(contextText).not.toContain("outside-control.txt");
    const progress = page.locator(".chat-progress").last();
    await expect(progress).not.toHaveAttribute("open");
    await progress.locator("summary").click();
    await expect(progress.locator(".chat-search-round")).toHaveCount(2);
    await expect(
      progress.locator('.chat-search-round[data-round="1"] .chat-search-query'),
    ).toHaveText(["operator", "comparison"]);
    await expect(progress).toContainText("2 轮查阅");
    await expect(progress).toContainText("已检索到 2 条信息");
    expect(await progress.innerText()).not.toMatch(
      /cosine|debug|notice|耗时|\d+\s*ms/i,
    );
    await expect(
      markdown.locator(".citation-marker:not(:disabled)"),
    ).toHaveCount(2);
    await page.screenshot({
      path: path.join(out, "scoped-chat-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    let previousLayout = "";
    await expect
      .poll(async () => {
        const box = await page.locator(".workspace").boundingBox();
        const layout = `${Math.round(box!.x)}:${Math.round(box!.width)}`;
        const stable = layout === previousLayout;
        previousLayout = layout;
        return stable;
      })
      .toBe(true);
    expect(
      await progress
        .locator(".chat-search-query")
        .evaluateAll((nodes) =>
          nodes.every((node) => node.scrollWidth <= node.clientWidth + 1),
        ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await progress.locator(".chat-search-rounds").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(out, "scoped-chat-mobile.png"),
      fullPage: true,
    });
    const events = await page.evaluate(
      () =>
        (
          window as Window & {
            __scopedChatEvents?: {
              type: string;
              data: Record<string, unknown>;
            }[];
          }
        ).__scopedChatEvents || [],
    );
    const candidates = events.filter(
      (event) => event.type === "citation" && event.data.candidate,
    );
    expect(candidates).toHaveLength(2);
    expect(
      candidates.every((event) =>
        uploadIds.slice(0, 2).includes(String(event.data.document_id)),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
    evidence = {
      passed: true,
      kbId,
      conversationId,
      uploadedDocuments: uploadIds,
      nativeTurns: nativeTurn,
      chosenFilters,
      summaries,
      citations: answer.citations,
      candidateEvents: candidates,
      sseTypes: [...new Set(events.map((event) => event.type))],
      pageErrors,
      serverErrors,
    };
    await writeFile(
      path.join(out, "results.json"),
      JSON.stringify(evidence, null, 2),
    );
    await writeFile(
      path.join(out, "provider-requests.json"),
      JSON.stringify(calls, null, 2),
    );
    await writeFile(
      path.join(out, "sse-events.json"),
      JSON.stringify(events, null, 2),
    );
  } finally {
    try {
      await page.goto("about:blank").catch(() => {});
      if (kbId) await request.delete(`/api/knowledge-bases/${kbId}`);
    } finally {
      try {
        if (configurationChanged) {
          const current = await checked<{ revision: number }>(
            await request.get("/api/settings/config"),
          );
          const { api_key_configured: llmKey, ...llm } = initial.llm;
          const { api_key_configured: embeddingKey, ...embedding } =
            initial.embedding;
          void llmKey;
          void embeddingKey;
          await checked(
            await request.put("/api/settings/config", {
              data: {
                revision: current.revision,
                llm: { ...llm, clear_api_key: true },
                embedding: { ...embedding, clear_api_key: true },
                processing: initial.processing,
              },
            }),
          );
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (!evidence.passed)
          await writeFile(
            path.join(out, "failure-evidence.json"),
            JSON.stringify(
              { chosenFilters, nativeTurn, serverErrors, pageErrors, calls },
              null,
              2,
            ),
          );
      }
    }
  }
});
