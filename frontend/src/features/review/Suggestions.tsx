import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import { Empty, ErrorState, Loading } from "../../components/common";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog } from "../../components/ui/dialog";
import { errorText, query } from "../../lib/api";
import { reviewApi } from "./api";
import type {
  ReviewSuggestion,
  SuggestionPayload,
  SuggestionResult,
  SuggestionStatus,
} from "./api";
import { SuggestionEditor } from "./SuggestionEditor";
import { SuggestionRefresh } from "./SuggestionRefresh";

type Adjustment = {
  payload: SuggestionPayload;
  destination: string;
  tags: string[];
};
type ResultRow = SuggestionResult & { name: string };
const statuses: { id: SuggestionStatus; label: string }[] = [
  { id: "pending", label: "待审阅" },
  { id: "applied", label: "已应用" },
  { id: "rejected", label: "已拒绝" },
];

export function Suggestions({
  kbId,
  documentId,
  onShowPlan,
}: {
  kbId: string;
  documentId?: string;
  onShowPlan: (id: string) => void;
}) {
  const client = useQueryClient();
  const [status, setStatus] = useState<SuggestionStatus>("pending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<Record<string, Adjustment>>(
    {},
  );
  const [editing, setEditing] = useState<ReviewSuggestion | null>(null);
  const [confirming, setConfirming] = useState<ReviewSuggestion[] | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const list = useQuery({
    queryKey: ["review", "suggestions", kbId, documentId, status, page],
    queryFn: () => reviewApi.suggestions(kbId, status, page, documentId),
    refetchInterval: 10000,
  });
  const rows = list.data?.items || [];
  const editableRows = rows.filter(
    (row) =>
      row.status === "pending" &&
      row.can_edit !== false &&
      row.document_available !== false &&
      !["queued", "running", "retry_wait"].includes(row.refresh_status || ""),
  );
  const chosen = editableRows.filter((row) => selected.includes(row.id));
  const mutation = useMutation({
    mutationFn: ({
      action,
      items,
    }: {
      action: "apply" | "reject";
      items: ReviewSuggestion[];
    }) =>
      reviewApi.apply(
        action,
        items.map((item) => ({
          suggestion_id: item.suggestion_id || item.id,
          document_version: item.document_version,
          ...(action === "apply" && adjustments[item.id]
            ? { payload: adjustments[item.id].payload }
            : {}),
        })),
      ),
    onSuccess: async (result, variables) => {
      setConfirming(null);
      setResults(
        result.items.map((item) => ({
          ...item,
          name:
            variables.items.find(
              (row) => (row.suggestion_id || row.id) === item.suggestion_id,
            )?.document_name || "文档建议",
        })),
      );
      const failedIds = new Set(
        result.items
          .filter((item) => ["failed", "conflict"].includes(item.status))
          .map((item) => item.suggestion_id),
      );
      setSelected(
        variables.items
          .filter((item) => failedIds.has(item.suggestion_id || item.id))
          .map((item) => item.id),
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ["review"] }),
        client.invalidateQueries({ queryKey: ["documents"] }),
        client.invalidateQueries({ queryKey: ["document"] }),
        client.invalidateQueries({ queryKey: ["suggestion"] }),
        client.invalidateQueries({ queryKey: ["folders"] }),
        client.invalidateQueries({ queryKey: ["tags"] }),
      ]);
    },
  });
  function tags(item: ReviewSuggestion) {
    return (
      adjustments[item.id]?.tags || [
        ...(item.existing_tag_names || []),
        ...item.payload.new_tag_names,
      ]
    );
  }
  const totalPages = Math.max(1, Math.ceil((list.data?.total || 0) / 30));
  return (
    <div className="suggestion-review">
      <div className="review-subnav">
        <div className="review-segments" aria-label="建议状态">
          {statuses.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={status === item.id}
              onClick={() => {
                setStatus(item.id);
                setPage(1);
                setSelected([]);
                setResults([]);
              }}
            >
              {item.label}
              <span>{list.data?.counts[item.id] || 0}</span>
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新建议"
          onClick={() => void list.refetch()}
        >
          <RefreshCw size={15} className={list.isFetching ? "spin" : ""} />
        </Button>
      </div>
      {results.length > 0 && (
        <section
          className="review-results"
          aria-label="逐项处理结果"
          aria-live="polite"
        >
          <div className="row spread">
            <strong>本次处理结果</strong>
            <Button
              variant="ghost"
              size="icon"
              aria-label="收起处理结果"
              onClick={() => setResults([])}
            >
              <X size={13} />
            </Button>
          </div>
          <ul>
            {results.map((result) => (
              <li
                key={result.suggestion_id}
                className={
                  result.status === "conflict" || result.status === "failed"
                    ? "review-result-failed"
                    : ""
                }
              >
                <span>{result.name}</span>
                <span>
                  {result.status === "applied"
                    ? "已应用"
                    : result.status === "rejected"
                      ? "已拒绝"
                      : result.message ||
                        (result.status === "conflict"
                          ? "文档有更新，请重新审阅"
                          : "处理失败")}
                </span>
                {result.run_id && (
                  <button
                    type="button"
                    onClick={() => onShowPlan(result.run_id!)}
                  >
                    查看记录 / 撤销
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {mutation.isError && <ErrorState error={mutation.error} />}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : !rows.length ? (
        <Empty
          title={status === "pending" ? "没有待审阅的分类建议" : "暂无处理记录"}
        >
          {status === "pending"
            ? "新资料生成分类建议后会出现在这里；正文和检索可提前使用。"
            : "调整知识库筛选可查看其他记录。"}
        </Empty>
      ) : (
        <>
          {status === "pending" && (
            <div className="review-selection-bar">
              <label className="checkbox-label">
                <Checkbox
                  aria-label="选择本页建议"
                  disabled={mutation.isPending || !editableRows.length}
                  checked={
                    !!editableRows.length &&
                    chosen.length === editableRows.length
                  }
                  indeterminate={
                    chosen.length > 0 && chosen.length < editableRows.length
                  }
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? editableRows.map((row) => row.id)
                        : [],
                    )
                  }
                />
                本页{chosen.length ? ` · 已选 ${chosen.length} 条` : ""}
              </label>
              <div>
                <Button
                  size="sm"
                  disabled={!chosen.length || mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ action: "reject", items: chosen })
                  }
                >
                  <X size={13} />
                  拒绝所选
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  disabled={!chosen.length || mutation.isPending}
                  onClick={() => setConfirming(chosen)}
                >
                  <Check size={13} />
                  应用所选
                </Button>
              </div>
            </div>
          )}
          <div className="review-suggestion-list">
            {rows.map((item) => {
              const outcome = results.find(
                (result) =>
                  result.suggestion_id === (item.suggestion_id || item.id),
              );
              return (
                <article
                  className={`review-suggestion-row${documentId === item.document_id ? " is-focused" : ""}`}
                  key={item.id}
                >
                  {status === "pending" && (
                    <Checkbox
                      aria-label={`选择建议：${item.document_name}`}
                      disabled={
                        mutation.isPending ||
                        item.can_edit === false ||
                        item.document_available === false ||
                        ["queued", "running", "retry_wait"].includes(
                          item.refresh_status || "",
                        )
                      }
                      checked={selected.includes(item.id)}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, item.id]
                            : previous.filter((id) => id !== item.id),
                        )
                      }
                    />
                  )}
                  <div className="review-suggestion-content">
                    <div className="review-row-title">
                      <strong>{item.document_name}</strong>
                      <span>{item.kb_name}</span>
                    </div>
                    <p className="review-note">
                      位置：{item.current_folder_path || "知识库根目录"}
                    </p>
                    {!!tags(item).length && (
                      <div className="review-inline-tags">
                        {tags(item).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    )}
                    <p className="review-reason">
                      {adjustments[item.id]?.payload.reason ||
                        item.payload.reason}
                    </p>
                    {item.conflict && (
                      <p className="review-row-warning">
                        文档在建议生成后有更新，应用时会检查版本。
                      </p>
                    )}
                    {item.conflict && status === "pending" && (
                      <SuggestionRefresh item={item} />
                    )}
                    {outcome &&
                      ["failed", "conflict"].includes(outcome.status) && (
                        <p role="alert" className="review-row-warning">
                          {outcome.message || "处理失败，请重新审阅"}
                        </p>
                      )}
                  </div>
                  <div className="review-row-actions">
                    {item.document_available !== false && (
                      <Link
                        to={`/document${query({ kb: item.kb_id, document: item.document_id, mode: "read" })}`}
                        aria-label={`查看原文：${item.document_name}`}
                        title="查看原文"
                      >
                        <ArrowUpRight size={16} />
                      </Link>
                    )}
                    {status === "pending" && item.can_edit !== false && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`调整建议：${item.document_name}`}
                        title="调整建议"
                        disabled={mutation.isPending}
                        onClick={() => setEditing(item)}
                      >
                        <Pencil size={14} />
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <footer className="review-pagination">
            <span>共 {list.data?.total || 0} 条</span>
            <div>
              <Button
                size="icon"
                variant="ghost"
                aria-label="上一页建议"
                disabled={page <= 1 || mutation.isPending}
                onClick={() => {
                  setPage((value) => value - 1);
                  setSelected([]);
                }}
              >
                <ChevronLeft size={16} />
              </Button>
              <span>
                {page} / {totalPages}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label="下一页建议"
                disabled={page >= totalPages || mutation.isPending}
                onClick={() => {
                  setPage((value) => value + 1);
                  setSelected([]);
                }}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </footer>
        </>
      )}
      {editing && (
        <SuggestionEditor
          item={editing}
          initial={adjustments[editing.id]?.payload || editing.payload}
          onClose={() => setEditing(null)}
          onSave={(payload, destination, tags) => {
            setAdjustments((previous) => ({
              ...previous,
              [editing.id]: { payload, destination, tags },
            }));
            setEditing(null);
          }}
        />
      )}
      <Dialog
        open={!!confirming}
        onOpenChange={(open) =>
          !open && !mutation.isPending && setConfirming(null)
        }
        title={`应用 ${confirming?.length || 0} 条分类建议`}
        description="应用标签建议并保留文档当前位置；文件夹整理可另行生成方案。"
      >
        <div className="review-confirm-list">
          {confirming?.map((item) => (
            <div key={item.id}>
              <strong>{item.document_name}</strong>
              {!!tags(item).length && (
                <small>添加标签：{tags(item).join("、")}</small>
              )}
            </div>
          ))}
        </div>
        {mutation.isError && (
          <p role="alert" className="review-row-warning">
            {errorText(mutation.error)}
          </p>
        )}
        <div className="dialog-actions">
          <Button
            disabled={mutation.isPending}
            onClick={() => setConfirming(null)}
          >
            返回审阅
          </Button>
          <Button
            variant="default"
            disabled={mutation.isPending || !confirming?.length}
            onClick={() =>
              confirming &&
              mutation.mutate({ action: "apply", items: confirming })
            }
          >
            {mutation.isPending ? "正在应用…" : "确认应用"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
