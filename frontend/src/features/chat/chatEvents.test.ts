import { expect, it } from "vitest";
import { mergeChatEvents } from "./chatEvents";
import type { Message, StreamEvent } from "../../lib/api";

const token = (
  sequence: number,
  text: string,
  offset: number,
): StreamEvent => ({
  type: "token",
  sequence,
  data: { message_id: "m-1", token: text, offset },
});

it("流式批次与中途快照按序号及UTF-16偏移合并为同一条消息", () => {
  const snapshot: Message[] = [
    {
      id: "m-1",
      role: "assistant",
      content: "📚中文",
      status: "processing",
      retrieval: { stream_sequence: 4 },
    },
  ];
  const merged = mergeChatEvents(snapshot, [
    token(3, "📚", 0),
    token(4, "中文", 2),
    token(5, "检索", 4),
    token(5, "检索", 4),
  ]);
  expect(merged).toHaveLength(1);
  expect(merged[0].content).toBe("📚中文检索");
  expect(mergeChatEvents(snapshot, [token(5, "检索", 40)])[0].content).toBe(
    "📚中文",
  );
});

it("重试重置旧正文和来源，完成消息保留正文与执行步骤，重连不重放旧事件", () => {
  const old: Message = {
    id: "m-1",
    role: "assistant",
    content: "旧输出",
    status: "failed",
    error: "旧错误",
    citations: [{ ordinal: 1, document_id: "old", chunk_id: "old" }],
    retrieval: { stream_sequence: 3 },
  };
  const steps = [
    { stage: "generation", label: "生成回答", status: "completed" },
  ];
  const events: StreamEvent[] = [
    { type: "status", sequence: 4, data: { message_id: "m-1", reset: true } },
    {
      type: "citation",
      sequence: 5,
      data: {
        message_id: "m-1",
        ordinal: 2,
        document_id: "doc",
        chunk_id: "chunk",
      },
    },
    token(6, "新回答[S2]", 0),
    {
      type: "completed",
      sequence: 7,
      data: { message_id: "m-1", content: "新回答[S2]", steps },
    },
  ];
  const answer = mergeChatEvents([old], events)[0];
  expect(answer).toMatchObject({
    content: "新回答[S2]",
    status: "completed",
    error: undefined,
    retrieval: { execution: steps },
  });
  expect(answer.citations?.map((citation) => citation.document_id)).toEqual([
    "doc",
  ]);
  const persisted = {
    ...answer,
    retrieval: { ...answer.retrieval, stream_sequence: 7 },
  };
  expect(mergeChatEvents([persisted], events)).toEqual([persisted]);
});

it("SSE过程保留模式与真实工具快照，新的权限遮蔽快照优先于旧重放事件", () => {
  const steps = [{
    stage: "tool_activity", tool_name: "read_document", call_id: "read-one", label: "阅读原文", status: "completed",
    source: { document_id: "doc", chunk_id: "chunk", document_name: "旧标题", snippet: "旧片段", available: true },
  }];
  const events: StreamEvent[] = [{
    type: "progress", sequence: 4, data: { message_id: "m-1", retrieval_mode: "model", steps },
  }];
  const projected = mergeChatEvents([], events)[0];
  expect(projected.retrieval).toMatchObject({ retrieval_mode: "model", execution: steps });
  expect(projected.content).toBe("");
  const redacted = { ...projected, retrieval: {
    ...projected.retrieval, stream_sequence: 4,
    execution: [{ stage: "tool_activity", tool_name: "read_document", call_id: "read-one", label: "阅读原文", status: "completed" as const, available: false }],
  } };
  expect(mergeChatEvents([redacted], events)).toEqual([redacted]);
});
