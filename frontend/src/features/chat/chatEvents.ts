import type { ChatStep, Citation, Message, StreamEvent } from "../../lib/api";

export const isMessageBusy = (message: Message) =>
  ["queued", "running", "generating", "processing"].includes(
    message.status || "",
  );

/** Reconcile durable SSE with a snapshot without an extra assistant bubble. */
export function mergeChatEvents(
  snapshot: Message[],
  events: StreamEvent[],
): Message[] {
  const messages = new Map(snapshot.map((message) => [message.id, message]));
  for (const event of events) {
    const data = event.data || {};
    if (typeof data.message_id !== "string") continue;
    const id = data.message_id;
    const previous = messages.get(id) || {
      id,
      role: "assistant",
      content: "",
      status: "queued",
    };
    const watermark = previous.retrieval?.stream_sequence || 0;
    if (event.sequence && event.sequence <= watermark) continue;
    const message = { ...previous };
    message.retrieval = { ...previous.retrieval };
    if (data.retrieval_mode === "direct" || data.retrieval_mode === "model")
      message.retrieval.retrieval_mode = data.retrieval_mode;
    if (Array.isArray(data.steps))
      message.retrieval.execution = data.steps as ChatStep[];
    if (event.type === "status") {
      message.status = "processing";
      if (data.reset) {
        message.content = "";
        message.error = undefined;
        message.citations = [];
        message.retrieval.execution = [];
      }
    } else if (event.type === "progress") {
      message.status = "processing";
    } else if (event.type === "token" && typeof data.token === "string") {
      const offset =
        typeof data.offset === "number" ? data.offset : message.content.length;
      // Snapshots may already contain all or part of this committed batch.
      // A gap waits for the next API snapshot rather than inventing text.
      if (offset <= message.content.length) {
        const consumed = message.content.length - offset;
        message.content += data.token.slice(consumed);
      }
      message.status = "processing";
    } else if (
      event.type === "citation" &&
      typeof data.document_id === "string" &&
      typeof data.chunk_id === "string"
    ) {
      const citation = data as Citation;
      message.citations = [
        ...(message.citations || []).filter(
          (item) => item.ordinal !== citation.ordinal,
        ),
        citation,
      ].sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
    } else if (event.type === "completed" || event.type === "error") {
      message.status = event.type === "completed" ? "completed" : "failed";
      if (typeof data.content === "string") message.content = data.content;
      if (event.type === "error")
        message.error = String(data.message || "回答生成失败");
    }
    // Keep the API watermark: the event projection must remain replayable
    // when a newer (or previously in-flight) authoritative snapshot arrives.
    messages.set(id, message);
  }
  return [...messages.values()];
}
