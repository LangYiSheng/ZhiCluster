import { api, json, query } from "../../lib/api";
import type { Folder, Operation, StreamEvent, Tag } from "../../lib/api";

export type SuggestionStatus = "pending" | "applied" | "rejected";
export type SuggestionPayload = {
  existing_folder_id?: string | null;
  proposed_folder_path?: string | null;
  existing_tag_ids: string[];
  new_tag_names: string[];
  short_summary?: string;
  reason: string;
  confidence_hint?: string;
};
export type ReviewSuggestion = {
  id: string;
  suggestion_id: string;
  document_id: string;
  document_name: string;
  kb_id: string;
  kb_name: string;
  status: SuggestionStatus;
  payload: SuggestionPayload;
  document_version: number;
  current_version: number;
  conflict: boolean;
  current_folder_path?: string;
  target_folder_path?: string;
  existing_tag_names?: string[];
  document_available?: boolean;
  can_edit?: boolean;
  refresh_job_id?: string | null;
  refresh_status?: string | null;
  refresh_error?: string | null;
};
export type SuggestionPage = {
  items: ReviewSuggestion[];
  total: number;
  page: number;
  page_size: number;
  counts: Record<SuggestionStatus, number>;
};
export type SuggestionResult = {
  suggestion_id: string;
  document_id?: string;
  status: "applied" | "rejected" | "conflict" | "failed";
  code?: string;
  message?: string;
  run_id?: string;
};
export type BatchResult = {
  items: SuggestionResult[];
  succeeded: number;
  failed: number;
};
export type OperationPreview = {
  operation_id: string;
  targets: {
    id: string;
    name: string;
    kind: string;
    folder_path?: string;
    available?: boolean;
    usage_count?: number;
    affected_documents?: AffectedDocument[];
  }[];
  destination_path?: string;
};
export type AffectedDocument = {
  id: string;
  name: string;
  available: boolean;
  deleted: boolean;
};
export type ReviewPlan = {
  id: string;
  version: number;
  status: string;
  payload: {
    summary: string;
    operations: Operation[];
    expected_changes: number;
    risk_level: string;
    base_versions: Record<string, number>;
    base_tag_links?: Record<string, string[]>;
  };
  preview?: OperationPreview[];
};
export type ReviewRun = {
  id: string;
  kb_id: string;
  goal: string;
  status: string;
  error?: string | null;
  created_at?: string;
  plan?: ReviewPlan;
  events?: StreamEvent[];
};

export const reviewApi = {
  suggestions: (
    kbId: string,
    status: SuggestionStatus,
    page: number,
    documentId?: string,
  ) =>
    api<SuggestionPage>(
      `/review/suggestions${query({ kb_id: kbId, status, page, page_size: 30, document_id: documentId })}`,
    ),
  apply: (
    action: "apply" | "reject",
    items: {
      suggestion_id: string;
      document_version: number;
      payload?: SuggestionPayload;
    }[],
  ) =>
    api<BatchResult>(
      "/review/suggestions/batch",
      json("POST", { action, items }),
    ),
  runs: (kbId: string) =>
    api<ReviewRun[]>(`/agent/runs${query({ kb_id: kbId })}`),
  run: (id: string) => api<ReviewRun>(`/agent/runs/${id}`),
  create: (kbId: string, goal: string) =>
    api<ReviewRun>(
      "/review/plans",
      json("POST", {
        kb_id: kbId,
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      }),
    ),
  save: (plan: ReviewPlan, operations: Operation[]) =>
    api<ReviewPlan>(
      `/agent/plans/${plan.id}`,
      json("PATCH", { version: plan.version, operations }),
    ),
  approve: (id: string, version: number, confirmed: boolean) =>
    api(
      `/agent/plans/${id}/approve`,
      json("POST", { plan_version: version, confirm_high_risk: confirmed }),
    ),
  reject: (id: string) => api(`/agent/plans/${id}/reject`, json("POST", {})),
  undo: (id: string) => api(`/agent/runs/${id}/undo`, json("POST")),
};

export function folderPath(
  id: string | null | undefined,
  folders: Folder[],
): string {
  if (!id) return "未分类";
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current) {
    if (seen.has(current)) return "文件夹路径异常";
    seen.add(current);
    const folder = folders.find(
      (item) => item.id === current && !item.deleted_at,
    );
    if (!folder) return "文件夹已不可用";
    parts.unshift(folder.name);
    current = folder.parent_id;
  }
  return parts.join(" / ");
}

export function operationDestination(
  op: Operation,
  folders: Folder[],
  operations: Operation[],
  seen = new Set<string>(),
): string {
  const id = String(
    (op.type === "create_folder" ? op.params.parent_id : op.params.folder_id) ||
      "",
  );
  let path: string;
  if (id.startsWith("ref:")) {
    const reference = operations.find(
      (item) =>
        item.operation_id === id.slice(4) && item.type === "create_folder",
    );
    if (!reference || seen.has(reference.operation_id))
      return "新建文件夹依赖不可用";
    path = operationDestination(
      reference,
      folders,
      operations,
      new Set([...seen, reference.operation_id]),
    );
  } else path = id ? folderPath(id, folders) : "未分类";
  if (op.type === "create_folder")
    return `${path === "未分类" ? "" : `${path} / `}${String(op.params.name || "未命名文件夹")}`;
  return path;
}

export function suggestionDestination(
  item: ReviewSuggestion,
  payload: SuggestionPayload,
  folders?: Folder[],
) {
  if (payload.proposed_folder_path)
    return `${payload.proposed_folder_path}（新建）`;
  if (folders) return folderPath(payload.existing_folder_id, folders);
  return (
    item.target_folder_path ||
    (payload.existing_folder_id ? "现有文件夹" : "未分类")
  );
}

export function tagNames(
  payload: SuggestionPayload,
  tags: Tag[],
  fallback: string[] = [],
) {
  const existing = payload.existing_tag_ids.map(
    (id, index) =>
      tags.find((tag) => tag.id === id)?.name || fallback[index] || "现有标签",
  );
  return [...existing, ...payload.new_tag_names];
}

export const planStatus: Record<string, string> = {
  queued: "等待生成",
  planning: "正在生成方案",
  running: "正在生成方案",
  pending_review: "待审阅",
  executing: "执行中",
  completed: "已执行",
  rejected: "已拒绝",
  undone: "已撤销",
  failed: "生成失败",
  cancelled: "已取消",
};

export const operationLabels: Record<string, string> = {
  create_folder: "新建文件夹",
  move_documents: "移动文档",
  update_document_tags: "调整标签",
  rename_document: "重命名文档",
  rename_folder: "重命名文件夹",
  trash_documents: "移到回收站",
  trash_empty_folders: "删除空文件夹",
  delete_tags: "删除标签",
};

export function operationTagDocuments(
  op: Operation,
  preview?: OperationPreview,
) {
  return [
    ...new Map(
      (preview?.targets || [])
        .filter((target) => op.target_ids.includes(target.id))
        .flatMap((target) => target.affected_documents || [])
        .map((document) => [document.id, document]),
    ).values(),
  ];
}

export function deletionPreviewComplete(
  op: Operation,
  preview?: OperationPreview,
) {
  if (op.type !== "delete_tags") return true;
  return op.target_ids.every((id) => {
    const target = preview?.targets.find((item) => item.id === id);
    return (
      !!target &&
      typeof target.usage_count === "number" &&
      target.usage_count >= 0 &&
      target.affected_documents?.length === target.usage_count &&
      target.affected_documents.every((document) => document.available)
    );
  });
}
