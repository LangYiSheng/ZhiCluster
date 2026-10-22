import { FolderOpen, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { errorText } from "../lib/api";
import type { ReactNode } from "react";
export function Empty({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon || <FolderOpen size={25} />}</span>
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading-state" role="status">
      <Loader2 className="spin" size={18} />
      正在加载…
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <TriangleAlert size={18} />
      <p>{errorText(error)}</p>
      {retry && (
        <Button size="sm" onClick={retry}>
          <RefreshCw size={14} />
          重试
        </Button>
      )}
    </div>
  );
}
export function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    queued: "排队中",
    parsing: "解析中",
    chunking: "切块中",
    embedding: "向量化",
    summarizing: "生成摘要",
    classifying: "分类建议",
    ready: "已就绪",
    completed: "已完成",
    partial_ready: "正文已就绪",
    failed: "失败",
    unconfigured: "未配置模型",
    not_configured: "未配置模型",
    pending: "待处理",
    cancelled: "已取消",
    running: "处理中",
    indexed: "已索引",
    skipped: "已跳过",
    pending_review: "等待审批",
    rejected: "已拒绝",
    undone: "已撤销",
    retry_wait: "等待重试",
  };
  return (
    <span className={`status status-${value}`}>{labels[value] || value}</span>
  );
}
