import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, History, Play, Undo2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { ErrorState, Loading } from "../../components/common";
import { api, errorText } from "../../lib/api";
import type { Folder, Operation, Tag } from "../../lib/api";
import { useSessionDraft } from "../../lib/useSessionDraft";
import {
  operationDestination,
  deletionPreviewComplete,
  operationLabels,
  operationTagDocuments,
  planStatus,
  reviewApi,
} from "./api";
import type { ReviewPlan, ReviewRun } from "./api";
import { OperationEditor } from "./OperationEditor";

type PlanDraft = { version: number; operations: Operation[] };
function readDraft(value: string): PlanDraft | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed.version === "number" &&
      Array.isArray(parsed.operations)
      ? (parsed as PlanDraft)
      : null;
  } catch {
    return null;
  }
}

export function PlanEditor({ run }: { run: ReviewRun }) {
  const client = useQueryClient();
  const plan = run.plan;
  const draftKey = `zhicluster:draft:v1:review-plan:${run.id}`;
  const [stored, setStored, clearStored] = useSessionDraft(draftKey);
  const draft = useMemo(() => readDraft(stored), [stored]);
  const operations =
    (plan?.status === "pending_review" ? draft?.operations : undefined) ||
    plan?.payload.operations ||
    [];
  const [confirmation, setConfirmation] = useState<"approve" | "undo" | null>(
    null,
  );
  const metadata = useQuery({
    queryKey: ["review", "metadata", run.kb_id],
    queryFn: async () => {
      const [folders, tags] = await Promise.all([
        api<Folder[]>(`/knowledge-bases/${run.kb_id}/folders`),
        api<Tag[]>(`/knowledge-bases/${run.kb_id}/tags`),
      ]);
      return { folders, tags };
    },
    enabled: !!plan,
  });
  const folders = metadata.data?.folders || [];
  const tags = metadata.data?.tags || [];
  const reviewing = !!plan && plan.status === "pending_review";
  const changedElsewhere =
    !!draft &&
    !!plan &&
    plan.status === "pending_review" &&
    draft.version !== plan.version;
  const selected = operations.filter((op) => op.enabled !== false);
  const selectedIds = new Set(selected.map((op) => op.operation_id));
  const dependencyError = selected.some((op) =>
    op.dependencies.some((id) => !selectedIds.has(id)),
  );
  const missingTargets = selected.some((op) =>
    op.target_ids.some(
      (id) =>
        !plan?.preview
          ?.find((preview) => preview.operation_id === op.operation_id)
          ?.targets.some(
            (target) => target.id === id && target.available !== false,
          ),
    ),
  );
  const missingNames = selected.some(
    (op) =>
      ["create_folder", "rename_document", "rename_folder"].includes(op.type) &&
      !String(op.params.name || "").trim(),
  );
  const invalidDestination = selected.some(
    (op) =>
      ["create_folder", "move_documents"].includes(op.type) &&
      /不可用|异常/.test(operationDestination(op, folders, operations)),
  );
  const incompleteDeletionPreview = selected.some(
    (op) =>
      !deletionPreviewComplete(
        op,
        plan?.preview?.find((item) => item.operation_id === op.operation_id),
      ),
  );
  const highRisk = selected.some((op) =>
    ["trash_documents", "trash_empty_folders", "delete_tags"].includes(op.type),
  );
  const canApprove =
    reviewing &&
    !!selected.length &&
    !changedElsewhere &&
    !dependencyError &&
    !missingTargets &&
    !missingNames &&
    !invalidDestination &&
    !incompleteDeletionPreview &&
    !!metadata.data;
  const mutation = useMutation({
    mutationFn: async (action: "save" | "approve" | "reject" | "undo") => {
      const submittedDraft = stored;
      if (action === "undo") {
        await reviewApi.undo(run.id);
        return submittedDraft;
      }
      if (!plan) return submittedDraft;
      if (action === "reject") {
        await reviewApi.reject(plan.id);
        return submittedDraft;
      }
      let current: ReviewPlan = plan;
      if (draft) {
        current = await reviewApi.save(plan, draft.operations);
        client.setQueryData<ReviewRun>(["review", "run", run.id], (previous) =>
          previous ? { ...previous, plan: current } : previous,
        );
        clearStored(draftKey, submittedDraft);
      }
      if (action === "approve")
        await reviewApi.approve(current.id, current.version, highRisk);
      return submittedDraft;
    },
    onSuccess: async (submittedDraft) => {
      clearStored(draftKey, submittedDraft);
      setConfirmation(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["review"] }),
        client.invalidateQueries({ queryKey: ["documents"] }),
        client.invalidateQueries({ queryKey: ["document"] }),
        client.invalidateQueries({ queryKey: ["folders"] }),
        client.invalidateQueries({ queryKey: ["tags"] }),
      ]);
    },
  });
  function change(index: number, next: Operation) {
    if (plan)
      setStored(
        JSON.stringify({
          version: draft?.version || plan.version,
          operations: operations.map((op, position) =>
            position === index ? next : op,
          ),
        }),
      );
  }
  if (!plan)
    return (
      <div className="review-plan-empty">
        <p>
          {run.status === "completed"
            ? "没有需要审批的变更"
            : ["queued", "planning", "running"].includes(run.status)
              ? "后台正在查阅资料并生成方案，文档阅读和检索仍可使用。"
              : run.error || "这次任务没有生成可审阅方案。"}
        </p>
      </div>
    );
  return (
    <div className="review-plan-editor">
      <div className="review-plan-summary">
        <strong>{plan.payload.summary}</strong>
        <p>
          {planStatus[run.status] || run.status} · 已选 {selected.length} 项操作
          · 涉及 {new Set(selected.flatMap((op) => op.target_ids)).size}{" "}
          个现有条目
        </p>
      </div>
      {changedElsewhere && (
        <div className="review-row-warning" role="alert">
          方案已在别处更新，请放弃旧草稿后重新审阅。
          <Button size="sm" onClick={() => clearStored()}>
            放弃旧草稿
          </Button>
        </div>
      )}
      {metadata.isPending ? (
        <Loading />
      ) : metadata.isError ? (
        <ErrorState
          error={metadata.error}
          retry={() => void metadata.refetch()}
        />
      ) : (
        <div>
          {operations.map((op, index) => (
            <OperationEditor
              key={`${plan.id}:${plan.version}:${op.operation_id}`}
              operation={op}
              operations={operations}
              preview={plan.preview?.find(
                (preview) => preview.operation_id === op.operation_id,
              )}
              kbId={run.kb_id}
              folders={folders}
              tags={tags}
              disabled={!reviewing || mutation.isPending || changedElsewhere}
              onChange={(next) => change(index, next)}
            />
          ))}
        </div>
      )}
      {dependencyError && (
        <p className="review-row-warning">
          部分已选操作依赖未选择的操作。请重新选择所需文件夹，或调整移动位置。
        </p>
      )}
      {missingTargets && reviewing && (
        <p className="review-row-warning">
          部分目标已失效或预览不完整，请刷新方案后再审批。
        </p>
      )}
      {missingNames && reviewing && (
        <p className="review-row-warning">
          请为已选择的文件夹或重命名操作填写名称。
        </p>
      )}
      {invalidDestination && reviewing && (
        <p className="review-row-warning">移动位置不可用，请调整目标文件夹。</p>
      )}
      {incompleteDeletionPreview && reviewing && (
        <p className="review-row-warning">
          标签删除的影响预览不完整，请刷新并重新审阅。
        </p>
      )}
      {mutation.isError && (
        <p className="review-row-warning" role="alert">
          {errorText(mutation.error)}
        </p>
      )}
      {reviewing && (
        <div className="review-plan-actions">
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("reject")}
          >
            <X size={14} />
            拒绝方案
          </Button>
          <div />
          <Button
            size="sm"
            disabled={!draft || !canApprove || mutation.isPending}
            onClick={() => mutation.mutate("save")}
          >
            <Check size={14} />
            保存调整
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!canApprove || mutation.isPending}
            onClick={() => setConfirmation("approve")}
          >
            <Play size={14} />
            批准所选并执行
          </Button>
        </div>
      )}
      {run.status === "completed" && (
        <div className="review-plan-actions">
          <span className="review-note">
            操作已执行，撤销前会再次检查版本。
          </span>
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => setConfirmation("undo")}
          >
            <Undo2 size={14} />
            撤销此次整理
          </Button>
        </div>
      )}
      {!!run.events?.length && (
        <details className="review-activity">
          <summary>
            <History size={13} />
            活动记录 · {run.events.length}
          </summary>
          <ol>
            {run.events.map((event, index) => (
              <li key={event.sequence || index}>
                {String(
                  event.data?.message ||
                    event.message ||
                    event.type ||
                    "状态更新",
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      <Dialog
        open={confirmation === "approve"}
        onOpenChange={(open) =>
          !open && !mutation.isPending && setConfirmation(null)
        }
        title={highRisk ? "确认包含删除操作的方案" : "确认执行整理方案"}
        description="将按下面显示的位置执行所选操作。未选择的操作不会执行。"
      >
        <div className="review-confirm-list">
          {selected.map((op) => (
            <div key={op.operation_id}>
              <strong>{operationLabels[op.type] || op.type}</strong>
              {plan.preview
                ?.find((item) => item.operation_id === op.operation_id)
                ?.targets.filter((target) => op.target_ids.includes(target.id))
                .map((target) => (
                  <p key={target.id}>
                    {target.name}
                    {op.type === "move_documents" && (
                      <>
                        <span>{target.folder_path || "未分类"}</span>
                        <ArrowRight size={12} />
                        <b>{operationDestination(op, folders, operations)}</b>
                      </>
                    )}
                  </p>
                ))}
              {op.type === "create_folder" && (
                <p>{operationDestination(op, folders, operations)}</p>
              )}
              {["rename_document", "rename_folder"].includes(op.type) && (
                <p>新名称：{String(op.params.name || "")}</p>
              )}
              {op.type === "update_document_tags" && (
                <small>
                  {
                    (
                      {
                        add: "添加标签",
                        set: "替换标签",
                        remove: "移除标签",
                      } as Record<string, string>
                    )[String(op.params.mode || "add")]
                  }
                  ：
                  {[
                    ...((op.params.tag_ids as string[]) || []).map(
                      (id) =>
                        tags.find((tag) => tag.id === id)?.name || "标签不可用",
                    ),
                    ...((op.params.new_tag_names as string[]) || []),
                  ].join("、") || "无标签"}
                </small>
              )}
              {op.type === "trash_documents" && (
                <p className="review-row-warning">以上文档将移入回收站。</p>
              )}
              {op.type === "trash_empty_folders" && (
                <p className="review-row-warning">
                  以上空文件夹将移入回收站，执行前会再次检查是否为空。
                </p>
              )}
              {op.type === "delete_tags" && (
                <div className="review-row-warning">
                  <p>
                    将删除以上标签，并移除{" "}
                    {
                      operationTagDocuments(
                        op,
                        plan.preview?.find(
                          (item) => item.operation_id === op.operation_id,
                        ),
                      ).length
                    }{" "}
                    份文档上的关联；文档内容保留。
                  </p>
                  <ul>
                    {operationTagDocuments(
                      op,
                      plan.preview?.find(
                        (item) => item.operation_id === op.operation_id,
                      ),
                    ).map((document) => (
                      <li key={document.id}>
                        {document.name}
                        {document.deleted ? "（回收站）" : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
        {mutation.isError && (
          <p className="review-row-warning" role="alert">
            {errorText(mutation.error)}
          </p>
        )}
        <div className="dialog-actions">
          <Button
            disabled={mutation.isPending}
            onClick={() => setConfirmation(null)}
          >
            返回审阅
          </Button>
          <Button
            variant={highRisk ? "danger" : "default"}
            disabled={!canApprove || mutation.isPending}
            onClick={() => mutation.mutate("approve")}
          >
            {mutation.isPending
              ? "正在执行…"
              : highRisk
                ? "确认删除并执行"
                : "确认执行"}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={confirmation === "undo"}
        onOpenChange={(open) =>
          !open && !mutation.isPending && setConfirmation(null)
        }
        title="撤销此次整理"
        description="会检查文档版本和后续修改，发生冲突时不会覆盖新内容。"
      >
        <div className="dialog-actions">
          <Button
            disabled={mutation.isPending}
            onClick={() => setConfirmation(null)}
          >
            取消
          </Button>
          <Button
            variant="default"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("undo")}
          >
            {mutation.isPending ? "正在撤销…" : "确认撤销"}
          </Button>
        </div>
        {mutation.isError && (
          <p role="alert" className="review-row-warning">
            {errorText(mutation.error)}
          </p>
        )}
      </Dialog>
    </div>
  );
}
