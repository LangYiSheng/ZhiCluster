import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog } from "../../components/ui/dialog";
import { Select } from "../../components/ui/select";
import { ErrorState, Loading } from "../../components/common";
import { api, errorText, json, query } from "../../lib/api";
import type { Document, KnowledgeBase } from "../../lib/api";
import type { ReviewRun } from "./api";

function CreatePlanFields({
  kbId,
  onCreated,
  onClose,
}: {
  kbId: string;
  onCreated: (run: ReviewRun) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [goal, setGoal] = useState("");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Record<string, string> | null>(
    null,
  );
  const documents = useQuery({
    queryKey: ["review", "plan-documents", kbId, page],
    queryFn: () =>
      api<{ items: Document[]; total: number }>(
        `/knowledge-bases/${kbId}/documents${query({ status: "ready", page, page_size: 50 })}`,
      ),
    enabled: !!kbId,
  });
  const rows = documents.data?.items || [];
  const selected =
    selection ||
    ((documents.data?.total || 0) <= 50
      ? Object.fromEntries(rows.map((doc) => [doc.id, doc.display_name]))
      : {});
  const selectedIds = Object.keys(selected);
  const mutation = useMutation({
    mutationFn: () =>
      api<ReviewRun>(
        "/review/plans",
        json("POST", {
          kb_id: kbId,
          document_ids: selectedIds,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
        }),
      ),
    onSuccess: async (run) => {
      await client.invalidateQueries({ queryKey: ["review", "runs"] });
      if (mounted.current) onCreated(run);
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (selectedIds.length && selectedIds.length <= 50) mutation.mutate();
      }}
    >
      <label>
        整理方向（可选）
        <input
          value={goal}
          disabled={mutation.isPending}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="按资料主题归类，并补充适合的标签"
        />
      </label>
      {documents.isPending ? (
        <Loading />
      ) : documents.isError ? (
        <ErrorState
          error={documents.error}
          retry={() => void documents.refetch()}
        />
      ) : !documents.data?.total ? (
        <p className="review-note">
          这个知识库还没有已解析的文档。正文解析完成后即可生成方案。
        </p>
      ) : (
        <details
          className="review-document-picker"
          open={documents.data.total > 50 ? true : undefined}
        >
          <summary>
            整理范围 · 已选 {selectedIds.length} / {documents.data.total} 份文档
          </summary>
          <p className="review-note">
            本次最多 50 份。只生成待审方案，不会自动移动文档。
          </p>
          <label className="checkbox-label">
            <Checkbox
              aria-label="选择本页整理文档"
              disabled={mutation.isPending}
              checked={!!rows.length && rows.every((doc) => doc.id in selected)}
              indeterminate={
                rows.some((doc) => doc.id in selected) &&
                !rows.every((doc) => doc.id in selected)
              }
              onChange={(event) => {
                const next = { ...selected };
                if (event.target.checked) {
                  for (const doc of rows) {
                    if (Object.keys(next).length >= 50) break;
                    next[doc.id] = doc.display_name;
                  }
                } else for (const doc of rows) delete next[doc.id];
                setSelection(next);
              }}
            />
            本页文档
          </label>
          <div className="review-document-choices">
            {rows.map((doc) => (
              <label className="checkbox-label" key={doc.id}>
                <Checkbox
                  checked={doc.id in selected}
                  disabled={
                    mutation.isPending ||
                    (!(doc.id in selected) && selectedIds.length >= 50)
                  }
                  onChange={(event) => {
                    const next = { ...selected };
                    if (event.target.checked) next[doc.id] = doc.display_name;
                    else delete next[doc.id];
                    setSelection(next);
                  }}
                />
                {doc.display_name}
              </label>
            ))}
          </div>
          {documents.data.total > 50 && (
            <div className="review-pagination">
              <span>每次最多选择 50 份</span>
              <div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="上一页整理文档"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft size={15} />
                </Button>
                <span>
                  {page} / {Math.ceil(documents.data.total / 50)}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="下一页整理文档"
                  disabled={page >= Math.ceil(documents.data.total / 50)}
                  onClick={() => setPage((value) => value + 1)}
                >
                  <ChevronRight size={15} />
                </Button>
              </div>
            </div>
          )}
        </details>
      )}
      {mutation.isError && (
        <p className="review-row-warning" role="alert">
          {errorText(mutation.error)}
        </p>
      )}
      <div className="dialog-actions">
        <Button type="button" disabled={mutation.isPending} onClick={onClose}>
          取消
        </Button>
        <Button
          type="submit"
          variant="default"
          disabled={
            !selectedIds.length ||
            selectedIds.length > 50 ||
            mutation.isPending ||
            documents.isPending ||
            documents.isError
          }
        >
          <Sparkles size={14} />
          {mutation.isPending ? "正在创建任务…" : "生成待审方案"}
        </Button>
      </div>
    </form>
  );
}

export function CreatePlan({
  knowledgeBases,
  initialKbId,
  onClose,
  onCreated,
}: {
  knowledgeBases: KnowledgeBase[];
  initialKbId: string;
  onClose: () => void;
  onCreated: (run: ReviewRun) => void;
}) {
  const [kbId, setKbId] = useState(initialKbId || knowledgeBases[0]?.id || "");
  return (
    <Dialog
      open
      title="自动整理现有文档"
      description="生成文件夹、移动位置和标签建议，审阅并批准后才会执行。"
      onOpenChange={(open) => !open && onClose()}
    >
      <label>
        知识库
        <Select
          aria-label="待整理知识库"
          value={kbId}
          onValueChange={setKbId}
          options={knowledgeBases.map((kb) => ({
            value: kb.id,
            label: kb.name,
          }))}
        />
      </label>
      {kbId && (
        <CreatePlanFields
          key={kbId}
          kbId={kbId}
          onCreated={onCreated}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}
