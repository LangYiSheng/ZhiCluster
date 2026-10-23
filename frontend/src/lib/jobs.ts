import type { Job } from "./api";

const activeStatuses = new Set([
  "queued",
  "running",
  "processing",
  "retry_wait",
]);
const retryableStatuses = new Set(["failed", "partial_ready", "cancelled"]);

export function isActiveJob(job: Job) {
  return activeStatuses.has(job.status);
}

export function jobProgress(job: Job) {
  return Number.isFinite(job.progress)
    ? Math.round(Math.min(100, Math.max(0, job.progress)))
    : 0;
}

export function jobNeedsAttention(job: Job) {
  return (
    job.status === "failed" ||
    job.status === "partial_ready" ||
    (job.status === "retry_wait" && Boolean(job.error))
  );
}

export function jobNeedsConfiguration(job: Job) {
  return jobNeedsAttention(job) && /需要配置|未配置/.test(job.error || "");
}

export function jobStatusLabel(job: Job) {
  if (jobNeedsConfiguration(job)) return "待配置模型";
  switch (job.status) {
    case "queued":
      return "未处理";
    case "running":
    case "processing":
      return `正在处理 ${jobProgress(job)}%`;
    case "retry_wait":
      return "等待自动重试";
    case "partial_ready":
      return "部分未完成";
    case "failed":
      return "处理失败";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    default:
      return "待处理";
  }
}

export function jobStageLabel(job: Job) {
  const labels: Record<string, string> = {
    queued: "等待处理",
    parsing: "解析正文",
    chunking: "建立文本索引",
    embedding: "生成向量索引",
    summarizing: "生成摘要",
    classifying: "生成分类建议",
    completed: "本次处理已结束",
  };
  return (
    labels[job.stage || ""] || (job.kind === "chat" ? "生成回答" : "处理资料")
  );
}

export function canRetryJob(job: Job) {
  return (
    retryableStatuses.has(job.status) &&
    job.kind !== "agent" &&
    job.document_available !== false
  );
}

export function canCancelJob(job: Job) {
  return isActiveJob(job);
}
