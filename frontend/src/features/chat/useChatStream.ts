import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Message, StreamEvent } from "../../lib/api";
import { useEvents } from "../../lib/events";
import { mergeChatEvents } from "./chatEvents";

/** Batch network fragments before parsing Markdown; snapshots stay authoritative. */
export function useChatStream(conversationId: string, snapshot: Message[]) {
  const client = useQueryClient();
  const [projection, setProjection] = useState<{
    id: string;
    events: StreamEvent[];
  }>({ id: "", events: [] });
  const pending = useRef<{ id: string; events: StreamEvent[] }>({
    id: "",
    events: [],
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = { id: "", events: [] };
    },
    [conversationId],
  );

  useEvents(
    conversationId ? `/conversations/${conversationId}/events` : null,
    (event) => {
      if (pending.current.id !== conversationId)
        pending.current = { id: conversationId, events: [] };
      pending.current.events.push(event);
      const flush = () => {
        timer.current = null;
        const batch = pending.current;
        pending.current = { id: conversationId, events: [] };
        if (batch.id !== conversationId || !batch.events.length) return;
        const watermarks = new Map(
          snapshotRef.current.map((message) => [
            message.id,
            message.retrieval?.stream_sequence || 0,
          ]),
        );
        setProjection((previous) => ({
          id: conversationId,
          events: [
            ...(previous.id === conversationId ? previous.events : []),
            ...batch.events,
          ].filter(
            (item) =>
              !item.sequence ||
              item.sequence >
                (watermarks.get(String(item.data?.message_id)) || 0),
          ),
        }));
      };
      if (["completed", "error"].includes(event.type || "")) {
        if (timer.current) clearTimeout(timer.current);
        flush();
        void client.invalidateQueries({
          queryKey: ["messages", conversationId],
        });
        void client.invalidateQueries({ queryKey: ["tasks"] });
      } else if (!timer.current) {
        timer.current = setTimeout(flush, 60);
      }
    },
  );
  return useMemo(
    () =>
      mergeChatEvents(
        snapshot,
        projection.id === conversationId ? projection.events : [],
      ),
    [snapshot, projection, conversationId],
  );
}
