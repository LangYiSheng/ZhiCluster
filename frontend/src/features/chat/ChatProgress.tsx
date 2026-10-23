import { Check, ChevronDown, CircleAlert, LoaderCircle } from "lucide-react";
import type { Message } from "../../lib/api";
import { isMessageBusy } from "./chatEvents";
import { retrievalNotice } from "../search/retrievalNotice";

export function ChatProgress({ message }: { message: Message }) {
  const busy = isMessageBusy(message);
  const steps = message.retrieval?.execution || [];
  if (!busy && !steps.length) return null;
  const current = steps.at(-1);
  const notice = retrievalNotice(current?.notice || message.retrieval?.notice);
  const label = busy
    ? current?.label || "等待任务开始"
    : message.status === "failed"
      ? "处理未完成"
      : "已完成资料查阅";
  return (
    <details
      className={`chat-progress ${busy ? "is-running" : ""}`}
      key={busy ? "live" : "finished"}
      open={busy ? true : undefined}
    >
      <summary>
        {busy ? (
          <LoaderCircle className="progress-spinner" size={14} />
        ) : message.status === "failed" ? (
          <CircleAlert size={14} />
        ) : (
          <Check size={14} />
        )}
        <span aria-live="polite">{label}</span>
        <ChevronDown size={13} className="progress-chevron" />
      </summary>
      <ol aria-label="资料查阅过程">
        {steps.length ? (
          steps.map((step, index) => (
            <li
              key={`${step.stage}-${step.call_id || ""}-${index}`}
              className={`execution-step is-${step.status}`}
            >
              {step.status === "running" ? (
                <LoaderCircle size={12} className="progress-spinner" />
              ) : step.status === "failed" ? (
                <CircleAlert size={12} />
              ) : (
                <Check size={12} />
              )}
              <div className="execution-step-content">
                <span>
                  {step.label}
                  {typeof step.source_count === "number"
                    ? ` · ${step.source_count} 个片段`
                    : ""}
                </span>
                {step.query && (
                  <p className="execution-query" title={step.query}>
                    {step.query}
                  </p>
                )}
                {(step.tool_name || typeof step.round === "number") && (
                  <span className="execution-tool">
                    {step.tool_name === "search_knowledge"
                      ? "搜索知识库"
                      : step.tool_name}
                    {step.tool_name && typeof step.round === "number"
                      ? " · "
                      : ""}
                    {typeof step.round === "number"
                      ? `第 ${step.round} 轮`
                      : ""}
                  </span>
                )}
              </div>
              {typeof step.elapsed_ms === "number" && (
                <small>
                  {step.elapsed_ms < 1000
                    ? `${step.elapsed_ms} ms`
                    : `${(step.elapsed_ms / 1000).toFixed(1)} s`}
                </small>
              )}
            </li>
          ))
        ) : (
          <li className="execution-step">
            <LoaderCircle size={12} className="progress-spinner" />
            <span>问题已排队，等待工作进程</span>
          </li>
        )}
      </ol>
      {notice && <p className="execution-notice">{notice}</p>}
    </details>
  );
}
