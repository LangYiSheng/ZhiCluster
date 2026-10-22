import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  CheckCheck,
  Circle,
  GitBranch,
  History,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, errorText, json } from "../../lib/api";
import type { Folder, Operation, StreamEvent, Tag } from "../../lib/api";
import { useEvents } from "../../lib/events";
import { useSessionDraft } from "../../lib/useSessionDraft";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { ErrorState, Status } from "../../components/common";
type PlanPayload = {
  summary: string;
  operations: Operation[];
  expected_changes: number;
  risk_level: string;
  base_versions: Record<string, number>;
};
type Plan = {
  id: string;
  version: number;
  status: string;
  payload: PlanPayload;
};
type Run = {
  id: string;
  status: string;
  goal: string;
  error?: string;
  plan?: Plan;
  events?: StreamEvent[];
};
const labels: Record<string, string> = {
  create_folder: "新建文件夹",
  move_documents: "移动文档",
  update_document_tags: "设置标签",
  rename_document: "重命名文档",
  rename_folder: "重命名文件夹",
  trash_documents: "移到回收站",
};
export function Agent({
  kbId,
  folders,
  tags,
}: {
  kbId: string;
  folders: Folder[];
  tags: Tag[];
}) {
  const qc = useQueryClient();
  const [goal, setGoal] = useSessionDraft(`zhicluster:draft:v1:agent:${kbId}`);
  const [runId, setRunId] = useState(
    () => localStorage.getItem(`agent:${kbId}`) || "",
  );
  const [edited, setEdited] = useState<Operation[] | null>(null);
  const [riskDialog, setRiskDialog] = useState(false);
  const [undoDialog, setUndoDialog] = useState(false);
  const run = useQuery({
    queryKey: ["agent", runId],
    queryFn: () => api<Run>(`/agent/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) =>
      ["completed", "rejected", "failed", "undone", "cancelled"].includes(
        q.state.data?.status || "",
      )
        ? false
        : 2500,
  });
  useEffect(() => {
    localStorage.setItem(`agent:${kbId}`, runId);
    setEdited(null);
  }, [runId, kbId]);
  const create = useMutation({
    mutationFn: () =>
      api<Run>("/agent/runs", json("POST", { kb_id: kbId, goal })),
    onSuccess: (r) => {
      setRunId(r.id);
      setGoal("");
      setEdited(null);
      void qc.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  useEvents(runId ? `/agent/runs/${runId}/events` : null, (e) => {
    if (
      ["plan_ready", "approval_required", "completed", "error"].includes(
        e.type || "",
      )
    )
      void qc.invalidateQueries({ queryKey: ["agent", runId] });
  });
  const plan = run.data?.plan;
  const operations = edited || plan?.payload.operations || [];
  const reviewing =
    !!plan &&
    ["pending", "pending_review", "review", "awaiting_approval"].includes(
      plan.status,
    );
  const mutate = useMutation({
    mutationFn: async ({
      kind,
      confirmed = false,
    }: {
      kind: "save" | "approve" | "reject" | "undo";
      confirmed?: boolean;
    }) => {
      if (kind === "undo")
        return api(`/agent/runs/${runId}/undo`, json("POST"));
      if (!plan) return;
      let version = plan.version;
      if (edited && kind !== "reject") {
        const saved = await api<Plan>(
          `/agent/plans/${plan.id}`,
          json("PATCH", { version, operations: edited }),
        );
        version = saved.version;
      }
      if (kind === "save") return;
      if (kind === "reject")
        return api(`/agent/plans/${plan.id}/reject`, json("POST", {}));
      return api(
        `/agent/plans/${plan.id}/approve`,
        json("POST", { plan_version: version, confirm_high_risk: confirmed }),
      );
    },
    onSuccess: () => {
      setEdited(null);
      setRiskDialog(false);
      setUndoDialog(false);
      void qc.invalidateQueries();
      toast.success("操作已保存");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  function change(index: number, patch: Partial<Operation>) {
    setEdited(
      operations.map((op, i) => (i === index ? { ...op, ...patch } : op)),
    );
  }
  const selected = operations.filter((o) => o.enabled !== false);
  const highRisk = selected.some((o) => o.type === "trash_documents");
  const impacted = new Set(selected.flatMap((o) => o.target_ids)).size;
  return (
    <div className="agent-container page-scroll">
      <header className="agent-heading">
        <span className="eyebrow">
          <GitBranch size={15} />
          PLAN → REVIEW → EXECUTE
        </span>
        <h1>把整理交给知簇</h1>
        <p className="page-lead">
          描述你的目标。AI 查阅资料并制定计划，等你完整审阅后再执行。
        </p>
      </header>
      <form
        className="agent-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <textarea
          aria-label="智能整理目标"
          placeholder="例如：整理未分类的论文，按研究方向建立文件夹，并建议标签。"
          value={goal}
          disabled={create.isPending}
          onChange={(e) => setGoal(e.target.value)}
        />
        <div className="row spread">
          <span className="tiny muted">
            <ShieldCheck size={14} />
            审批前不会更改任何文件
          </span>
          <Button
            variant="default"
            disabled={!goal.trim() || create.isPending}
            type="submit"
          >
            {create.isPending ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <ArrowUp size={15} />
            )}
            生成整理计划
          </Button>
        </div>
      </form>
      {run.isError && (
        <ErrorState error={run.error} retry={() => void run.refetch()} />
      )}
      <div className="workflow-steps">
        {[
          ["1", "制定计划"],
          ["2", "整批审阅"],
          ["3", "执行与核验"],
        ].map(([n, label], i) => (
          <div
            className={
              (i === 0 && runId) ||
              (i === 1 && plan) ||
              (i === 2 && run.data?.status === "completed")
                ? "done"
                : ""
            }
            key={n}
          >
            <span>{n}</span>
            {label}
          </div>
        ))}
      </div>
      {run.data && (
        <>
          <section className="agent-run">
            <div className="row spread">
              <h3>
                <Sparkles size={17} />
                {run.data.goal}
              </h3>
              <Status value={run.data.status} />
            </div>
            {run.data.error && (
              <p className="notice warning">{run.data.error}</p>
            )}
            {plan && (
              <>
                <p className="muted">{plan.payload.summary}</p>
                <div className="plan-header">
                  <strong>整理计划</strong>
                  <small>
                    已选 {selected.length} 项操作 · 涉及 {impacted} 个现有条目
                  </small>
                </div>
                <div className="plan-operations">
                  {operations.map((op, index) => (
                    <div
                      className={`plan-operation ${op.enabled === false ? "operation-disabled" : ""}`}
                      key={op.operation_id}
                    >
                      <div className="row gap">
                        <input
                          aria-label={`选择操作 ${index + 1}`}
                          type="checkbox"
                          disabled={!reviewing}
                          checked={op.enabled !== false}
                          onChange={(e) =>
                            change(index, { enabled: e.target.checked })
                          }
                        />
                        <span className="operation-number">{index + 1}</span>
                        <strong>{labels[op.type] || op.type}</strong>
                        {op.type === "trash_documents" && (
                          <span className="status status-failed">
                            需额外确认
                          </span>
                        )}
                      </div>
                      <p>{op.description}</p>
                      <small className="muted">
                        目标 {op.target_ids.length} 项 · {op.operation_id}
                      </small>
                      {[
                        "rename_document",
                        "rename_folder",
                        "create_folder",
                      ].includes(op.type) && (
                        <label>
                          名称
                          <input
                            disabled={!reviewing}
                            value={String(op.params.name || "")}
                            onChange={(e) =>
                              change(index, {
                                params: { ...op.params, name: e.target.value },
                              })
                            }
                          />
                        </label>
                      )}
                      {op.type === "move_documents" && (
                        <label>
                          目标文件夹
                          <select
                            disabled={!reviewing}
                            value={String(op.params.folder_id || "")}
                            onChange={(e) =>
                              change(index, {
                                params: {
                                  ...op.params,
                                  folder_id: e.target.value || null,
                                },
                              })
                            }
                          >
                            <option value="">根目录 / 未分类</option>
                            {folders
                              .filter((f) => !f.deleted_at)
                              .map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.name}
                                </option>
                              ))}
                            {operations
                              .filter((o) => o.type === "create_folder")
                              .map((o) => (
                                <option
                                  key={o.operation_id}
                                  value={`ref:${o.operation_id}`}
                                >
                                  新建：
                                  {String(o.params.name || o.operation_id)}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {op.type === "update_document_tags" && (
                        <>
                          <label>
                            模式
                            <select
                              disabled={!reviewing}
                              value={String(op.params.mode || "add")}
                              onChange={(e) =>
                                change(index, {
                                  params: {
                                    ...op.params,
                                    mode: e.target.value,
                                  },
                                })
                              }
                            >
                              <option value="add">添加</option>
                              <option value="remove">移除</option>
                              <option value="set">替换</option>
                            </select>
                          </label>
                          <div className="tag-checks">
                            {tags.map((t) => (
                              <label className="checkbox-label" key={t.id}>
                                <input
                                  type="checkbox"
                                  disabled={!reviewing}
                                  checked={(
                                    (op.params.tag_ids as string[]) || []
                                  ).includes(t.id)}
                                  onChange={(e) =>
                                    change(index, {
                                      params: {
                                        ...op.params,
                                        tag_ids: e.target.checked
                                          ? [
                                              ...((op.params
                                                .tag_ids as string[]) || []),
                                              t.id,
                                            ]
                                          : (
                                              (op.params.tag_ids as string[]) ||
                                              []
                                            ).filter((id) => id !== t.id),
                                      },
                                    })
                                  }
                                />
                                {t.name}
                              </label>
                            ))}
                          </div>
                          <label>
                            新增标签（英文逗号分隔）
                            <input
                              disabled={!reviewing}
                              value={(
                                (op.params.new_tag_names as string[]) || []
                              ).join(", ")}
                              onChange={(e) =>
                                change(index, {
                                  params: {
                                    ...op.params,
                                    new_tag_names: e.target.value
                                      .split(",")
                                      .map((t) => t.trim())
                                      .filter(Boolean),
                                  },
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                      {op.type === "create_folder" && (
                        <label>
                          父文件夹
                          <select
                            disabled={!reviewing}
                            value={String(op.params.parent_id || "")}
                            onChange={(e) =>
                              change(index, {
                                params: {
                                  ...op.params,
                                  parent_id: e.target.value || null,
                                },
                              })
                            }
                          >
                            <option value="">根目录</option>
                            {folders
                              .filter((f) => !f.deleted_at)
                              .map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                    </div>
                  ))}
                </div>
                {reviewing && (
                  <div className="plan-actions">
                    <Button
                      disabled={mutate.isPending}
                      onClick={() => mutate.mutate({ kind: "reject" })}
                    >
                      <X size={15} />
                      拒绝计划
                    </Button>
                    <Button
                      disabled={mutate.isPending || !edited}
                      onClick={() => mutate.mutate({ kind: "save" })}
                    >
                      <Check size={15} />
                      保存调整
                    </Button>
                    <Button
                      variant="default"
                      disabled={mutate.isPending || !selected.length}
                      onClick={() =>
                        highRisk
                          ? setRiskDialog(true)
                          : mutate.mutate({ kind: "approve" })
                      }
                    >
                      <Play size={15} />
                      {mutate.isPending ? "执行中…" : "批准整个计划并执行"}
                    </Button>
                  </div>
                )}
                {["completed", "done"].includes(run.data.status) && (
                  <div className="plan-actions">
                    <span className="row gap success">
                      <CheckCheck size={17} />
                      整理已完成
                    </span>
                    <Button
                      disabled={mutate.isPending}
                      onClick={() => setUndoDialog(true)}
                    >
                      <Undo2 size={15} />
                      撤销此次整理
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
          {!!run.data.events?.length && (
            <details className="agent-timeline detail-disclosure">
              <summary>
                <History size={16} />
                活动记录 · {run.data.events.length} 条
              </summary>
              {run.data.events.map((e, i) => (
                <div className="timeline-row" key={e.sequence || i}>
                  <Circle size={8} />
                  <div>
                    <span>
                      {String(
                        e.data?.message || e.message || activityLabel(e.type),
                      )}
                    </span>
                    <small>
                      {e.timestamp
                        ? new Date(e.timestamp).toLocaleTimeString("zh-CN")
                        : e.type}
                    </small>
                  </div>
                </div>
              ))}
            </details>
          )}
        </>
      )}
      <Dialog
        open={riskDialog}
        onOpenChange={setRiskDialog}
        title="确认高风险操作"
        description={`编辑后的计划包含软删除，将影响 ${selected.filter((o) => o.type === "trash_documents").flatMap((o) => o.target_ids).length} 个文档。它们会进入回收站。`}
      >
        <div className="dialog-actions">
          <Button onClick={() => setRiskDialog(false)}>返回审阅</Button>
          <Button
            variant="danger"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate({ kind: "approve", confirmed: true })}
          >
            明确确认删除并执行整批计划
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={undoDialog}
        onOpenChange={setUndoDialog}
        title="撤销此次整理"
        description="系统会检查版本与后续更改；发生冲突时将阻止覆盖。"
      >
        <div className="dialog-actions">
          <Button onClick={() => setUndoDialog(false)}>取消</Button>
          <Button
            variant="default"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate({ kind: "undo" })}
          >
            确认撤销
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
function activityLabel(type?: string) {
  return (
    (
      {
        tool_start: "正在查阅知识",
        tool_end: "资料读取完成",
        plan_ready: "计划已准备好",
        approval_required: "等待整批审批",
        completed: "执行完成",
        error: "发生错误",
      } as Record<string, string>
    )[type || ""] ||
    type ||
    "状态已更新"
  );
}
