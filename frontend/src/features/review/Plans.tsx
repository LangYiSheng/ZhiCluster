import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, Loader2, RefreshCw } from "lucide-react";
import { Empty, ErrorState, Loading } from "../../components/common";
import { Button } from "../../components/ui/button";
import type { KnowledgeBase } from "../../lib/api";
import { useEvents } from "../../lib/events";
import { planStatus, reviewApi } from "./api";
import { PlanEditor } from "./PlanEditor";

const terminal = new Set([
  "pending_review",
  "completed",
  "rejected",
  "undone",
  "failed",
  "cancelled",
]);

export function Plans({
  kbId,
  knowledgeBases,
  selectedRunId,
  onSelectRun,
}: {
  kbId: string;
  knowledgeBases: KnowledgeBase[];
  selectedRunId: string;
  onSelectRun: (id: string) => void;
}) {
  const client = useQueryClient();
  const runs = useQuery({
    queryKey: ["review", "runs", kbId],
    queryFn: () => reviewApi.runs(kbId),
    refetchInterval: (query) =>
      query.state.data?.some((run) => !terminal.has(run.status)) ? 3000 : false,
  });
  const runId =
    selectedRunId ||
    runs.data?.find((run) => run.status === "pending_review")?.id ||
    runs.data?.[0]?.id ||
    "";
  const run = useQuery({
    queryKey: ["review", "run", runId],
    queryFn: () => reviewApi.run(runId),
    enabled: !!runId,
    refetchInterval: (query) =>
      terminal.has(query.state.data?.status || "") ? false : 2500,
  });
  useEvents(runId ? `/agent/runs/${runId}/events` : null, (event) => {
    if (
      ["plan_ready", "approval_required", "completed", "error"].includes(
        event.type || "",
      )
    ) {
      void client.invalidateQueries({ queryKey: ["review", "run", runId] });
      void client.invalidateQueries({ queryKey: ["review", "runs"] });
    }
  });
  if (runs.isPending) return <Loading />;
  if (runs.isError)
    return <ErrorState error={runs.error} retry={() => void runs.refetch()} />;
  if (!runs.data?.length && !selectedRunId)
    return (
      <Empty title="还没有整理方案" icon={<FileCheck2 size={25} />}>
        点击“自动整理现有文档”，先生成方案再决定是否执行。
      </Empty>
    );
  return (
    <div className="review-plan-layout">
      <aside className="review-run-list" aria-label="整理任务记录" tabIndex={0}>
        <div className="row spread">
          <small>最近的整理</small>
          <Button
            size="icon"
            variant="ghost"
            aria-label="刷新整理方案"
            onClick={() => {
              void runs.refetch();
              void run.refetch();
            }}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
        {runs.data?.map((item) => (
          <button
            type="button"
            className="review-run-row"
            aria-current={item.id === runId ? "true" : undefined}
            key={item.id}
            onClick={() => onSelectRun(item.id)}
          >
            <strong>{item.goal}</strong>
            <span>
              {knowledgeBases.find((kb) => kb.id === item.kb_id)?.name ||
                "知识库"}{" "}
              · {planStatus[item.status] || item.status}
            </span>
          </button>
        ))}
      </aside>
      <div
        className="review-selected-plan"
        role="region"
        aria-label="整理方案详情"
        tabIndex={0}
      >
        {run.isPending ? (
          <Loading />
        ) : run.isError ? (
          <ErrorState error={run.error} retry={() => void run.refetch()} />
        ) : (
          run.data && (
            <>
              <header className="review-selected-heading">
                <h2>{run.data.goal}</h2>
                <span>
                  {!terminal.has(run.data.status) && (
                    <Loader2 size={14} className="spin" />
                  )}
                  {planStatus[run.data.status] || run.data.status}
                </span>
              </header>
              {run.data.error && (
                <p role="alert" className="review-row-warning">
                  {run.data.error}
                </p>
              )}
              <PlanEditor key={run.data.id} run={run.data} />
            </>
          )
        )}
      </div>
    </div>
  );
}
