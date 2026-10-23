import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Empty, ErrorState, Loading } from "../../components/common";
import { Button } from "../../components/ui/button";
import { api, errorText, json, query } from "../../lib/api";
import type { Job, KnowledgeBase } from "../../lib/api";
import {
  canCancelJob,
  canRetryJob,
  isActiveJob,
  jobNeedsAttention,
  jobNeedsConfiguration,
  jobProgress,
  jobStageLabel,
  jobStatusLabel,
} from "../../lib/jobs";
import "./tasks.css";

type Filter = "attention" | "active" | "all" | "completed";
const filters: { id: Filter; label: string }[] = [
  { id: "attention", label: "需要处理" },
  { id: "active", label: "进行中" },
  { id: "all", label: "全部" },
  { id: "completed", label: "已完成" },
];
const jobKinds: Record<string, string> = {
  ingest: "文档处理",
  reindex: "重建向量索引",
  chat: "知识对话",
  agent: "整理任务",
};

function TaskRow({ job, kbId }: { job: Job; kbId: string }) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (action: "retry" | "cancel") =>
      api<Job>(`/ingestion/jobs/${job.id}/${action}`, json("POST")),
    onSuccess: async (_, action) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["tasks"] }),
        client.invalidateQueries({ queryKey: ["jobs"] }),
        client.invalidateQueries({ queryKey: ["document-jobs"] }),
        client.invalidateQueries({ queryKey: ["documents"] }),
        client.invalidateQueries({ queryKey: ["document"] }),
        client.invalidateQueries({ queryKey: ["messages"] }),
      ]);
      toast.success(action === "retry" ? "已重新加入任务队列" : "任务已取消");
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const attention = jobNeedsAttention(job);
  const active = isActiveJob(job);
  const running = job.status === "running" || job.status === "processing";
  const title =
    job.document_name ||
    (job.document_id
      ? job.document_available === false
        ? "已删除的文档"
        : "文档处理任务"
      : jobKinds[job.kind || ""] || "后台任务");
  const date = job.created_at
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(job.created_at))
    : "";
  const documentPath = `/document${query({ kb: kbId, document: job.document_id, mode: "read" })}`;
  return (
    <article className={`task-row${attention ? " task-needs-attention" : ""}`}>
      <span className="task-kind-icon" aria-hidden="true">
        {job.document_id ? <FileText size={19} /> : <MessageSquare size={19} />}
      </span>
      <div className="task-content">
        <div className="task-title-row">
          {job.document_id && job.document_available !== false ? (
            <Link className="task-title" to={documentPath} title={title}>
              {title}
            </Link>
          ) : (
            <strong className="task-title">{title}</strong>
          )}
          <span
            className={`task-status${attention ? " task-status-attention" : ""}${active ? " task-status-active" : ""}`}
          >
            {running ? (
              <Loader2 className="spin" size={12} />
            ) : attention ? (
              <CircleAlert size={12} />
            ) : job.status === "completed" ? (
              <Check size={12} />
            ) : (
              <Clock3 size={12} />
            )}
            {jobStatusLabel(job)}
          </span>
        </div>
        <p className="task-meta">
          <span>{jobKinds[job.kind || "ingest"] || "后台任务"}</span>
          {running && <span>{jobStageLabel(job)}</span>}
          {date && <time dateTime={job.created_at}>{date}</time>}
        </p>
        {running && (
          <div
            className="task-progress"
            role="progressbar"
            aria-label={`${title}的处理进度`}
            aria-valuenow={jobProgress(job)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${jobProgress(job)}%` }} />
          </div>
        )}
        {job.error && job.status !== "completed" && (
          <p className="task-error">{job.error}</p>
        )}
        {job.status === "retry_wait" && job.next_attempt_at && (
          <p className="task-retry-time">
            将在{" "}
            {new Date(job.next_attempt_at).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}{" "}
            自动重试
          </p>
        )}
        {mutation.isError && (
          <p className="task-error" role="alert">
            {errorText(mutation.error)}
          </p>
        )}
      </div>
      <div className="task-actions">
        {jobNeedsConfiguration(job) && (
          <Link
            className="button button-ghost button-sm"
            to={`/settings${query({ kb: kbId, section: "models" })}`}
          >
            配置模型
            <ArrowUpRight size={13} />
          </Link>
        )}
        {canRetryJob(job) && (
          <Button
            size="sm"
            onClick={() => mutation.mutate("retry")}
            disabled={mutation.isPending}
            aria-label={`重试 ${title}`}
          >
            <RefreshCw
              size={13}
              className={
                mutation.isPending && mutation.variables === "retry"
                  ? "spin"
                  : ""
              }
            />
            重试
          </Button>
        )}
        {canCancelJob(job) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mutation.mutate("cancel")}
            disabled={mutation.isPending}
            aria-label={`取消 ${title}`}
          >
            <X size={13} />
            取消
          </Button>
        )}
      </div>
    </article>
  );
}

export function Tasks({
  kb,
  documentId,
}: {
  kb: KnowledgeBase | null;
  documentId?: string;
}) {
  const [filter, setFilter] = useState<Filter>("attention");
  const jobs = useQuery({
    queryKey: ["tasks", kb?.id, documentId, filter],
    queryFn: () =>
      api<Job[]>(
        `/ingestion/jobs${query({ kb_id: kb!.id, document_id: documentId, group: filter === "all" ? undefined : filter })}`,
      ),
    enabled: Boolean(kb),
    refetchInterval: 4000,
  });
  if (!kb)
    return <Empty title="先选择一个知识库" icon={<ListChecks size={25} />} />;
  const visible = jobs.data || [];
  return (
    <section className="tasks-page">
      <header className="tasks-heading">
        <div>
          <p className="tasks-eyebrow">{kb.name}</p>
          <h1>任务列表</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新任务列表"
          onClick={() => void jobs.refetch()}
          disabled={jobs.isFetching}
        >
          <RefreshCw size={17} className={jobs.isFetching ? "spin" : ""} />
        </Button>
      </header>
      <div className="tasks-filter-bar">
        <div className="tasks-filters" aria-label="任务筛选">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              className={filter === item.id ? "is-active" : ""}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {documentId && (
          <Link
            className="button button-ghost button-sm"
            to={`/tasks${query({ kb: kb.id })}`}
          >
            查看整个知识库
            <X size={13} />
          </Link>
        )}
      </div>
      <div className="tasks-list">
        {jobs.isPending ? (
          <Loading />
        ) : jobs.isError ? (
          <ErrorState error={jobs.error} retry={() => void jobs.refetch()} />
        ) : visible.length ? (
          visible.map((job) => <TaskRow key={job.id} job={job} kbId={kb.id} />)
        ) : (
          <Empty
            title={
              filter === "attention"
                ? "没有需要处理的问题"
                : filter === "active"
                  ? "没有正在进行的任务"
                  : filter === "completed"
                    ? "还没有完成的任务"
                    : "还没有处理任务"
            }
            icon={
              filter === "attention" ? (
                <Check size={25} />
              ) : (
                <ListChecks size={25} />
              )
            }
          >
            {filter !== "all" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFilter("all")}
              >
                查看全部任务
              </Button>
            )}
          </Empty>
        )}
      </div>
      {visible.length >= 200 && (
        <p className="tasks-limit">显示当前筛选下最近 200 项任务</p>
      )}
    </section>
  );
}
