import { useEffect, useRef } from "react";
import type { StreamEvent } from "./api";
export function useEvents(
  path: string | null,
  onEvent: (event: StreamEvent) => void,
) {
  const callback = useRef(onEvent);
  useEffect(() => {
    callback.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    if (!path) return;
    let after = Number(sessionStorage.getItem(`events:${path}`) || 0);
    const source = new EventSource(
      `/api${path}${path.includes("?") ? "&" : "?"}after=${after}`,
    );
    const receive = (e: MessageEvent<string>) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const sequence = Number(e.lastEventId || data.sequence || 0);
      if (sequence && sequence <= after) return;
      if (sequence) {
        after = sequence;
        sessionStorage.setItem(`events:${path}`, String(sequence));
      }
      callback.current({
        type: e.type === "message" ? String(data.type || "message") : e.type,
        sequence,
        data: (data.data || data) as Record<string, unknown>,
      });
    };
    [
      "message",
      "status",
      "progress",
      "token",
      "tool_start",
      "tool_end",
      "plan_ready",
      "approval_required",
      "citation",
      "completed",
      "error",
    ].forEach((type) =>
      source.addEventListener(type, receive as EventListener),
    );
    return () => source.close();
  }, [path]);
}
