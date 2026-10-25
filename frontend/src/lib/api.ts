import { anchorNumber } from "./sourceAnchors";
import type { SourceAnchors } from "./sourceAnchors";

export type Entity = {
  id: string;
  name: string;
  version: number;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type KnowledgeBase = Entity & {
  description: string;
  icon?: string;
  color?: string;
  embedding_model?: string | null;
  embedding_dimension?: number | null;
};
export type Folder = Entity & { kb_id: string; parent_id: string | null };
export type Tag = Entity & { color: string; aliases?: string[] };
export type Document = {
  id: string;
  kb_id: string;
  folder_id: string | null;
  display_name: string;
  original_filename: string;
  ext: string;
  preview_type?: "pdf" | "text";
  size_bytes: number;
  version: number;
  parse_status: string;
  index_status: string;
  summary_status: string;
  classification_status: string;
  short_summary?: string;
  detailed_summary?: string;
  summary_metadata?: { keywords?: string[]; main_topics?: string[] };
  error?: string | null;
  deleted_at?: string | null;
  created_at: string;
  tags?: Tag[];
  tag_ids?: string[];
};
export type Section = {
  id: string;
  heading: string;
  plain_text: string;
  section_summary?: string;
  anchors?: SourceAnchors;
  page_start?: number;
  page_end?: number;
  paragraph_start?: number;
  paragraph_end?: number;
  line_start?: number;
  line_end?: number;
  order?: number;
};
export type Citation = {
  kb_id?: string | null;
  kb_name?: string | null;
  ext?: string | null;
  ordinal?: number;
  available?: boolean;
  document_id: string;
  chunk_id: string;
  display_name?: string;
  document_name?: string;
  snippet?: string;
  page_start?: number;
  line_start?: number;
  paragraph_start?: number;
  anchors?: SourceAnchors;
  anchor?: SourceAnchors;
  number?: number;
};
export type SearchResult = Citation & {
  content?: string;
  score: number;
  title?: string;
};
export type SearchResponse = {
  items: SearchResult[];
  mode?: string;
  notice?: string;
  elapsed_ms?: number;
  total?: number;
};
export type ChatStep = {
  stage: string;
  label: string;
  status: "running" | "completed" | "failed";
  elapsed_ms?: number;
  source_count?: number;
  mode?: string;
  notice?: string;
  query?: string;
  tool_name?: string;
  call_id?: string;
  round?: number;
  scope_key?: string;
  scope_label?: string;
  // Earlier embedding progress used this field for a numeric query count.
  queries?: string[] | number;
  query_count?: number;
};
export type Message = {
  id: string;
  role: string;
  content: string;
  status?: string;
  error?: string;
  citations?: Citation[];
  retrieval?: {
    execution?: ChatStep[];
    stream_sequence?: number;
    mode?: string;
    notice?: string;
  };
};
export type Conversation = {
  id: string;
  kb_id?: string;
  title: string;
  scope?: Record<string, unknown>;
  created_at?: string;
};
export type ChatModelCatalog = {
  models: string[];
  default_model: string;
  supports_tools: boolean;
};
export type Operation = {
  operation_id: string;
  type: string;
  target_ids: string[];
  params: Record<string, unknown>;
  description: string;
  dependencies: string[];
  enabled?: boolean;
  risk?: string;
};
export type AgentPlan = {
  id: string;
  plan_id?: string;
  kb_id: string;
  summary: string;
  goal: string;
  status: string;
  version?: number;
  operations: Operation[];
  base_versions: Record<string, number>;
  base_tag_links?: Record<string, string[]>;
  risk_level: string;
  expected_changes?: number;
};
export type AgentRun = {
  id: string;
  kb_id: string;
  status: string;
  error?: string;
  plan_id?: string;
  plan?: AgentPlan;
  events?: StreamEvent[];
};
export type StreamEvent = {
  id?: string;
  sequence?: number;
  type?: string;
  data?: Record<string, unknown>;
  message?: string;
  timestamp?: string;
};
export type Job = {
  id: string;
  kb_id?: string;
  document_id: string | null;
  document_name?: string | null;
  document_available?: boolean;
  kind?: string;
  status: string;
  stage?: string;
  progress: number;
  error?: string | null;
  attempts: number;
  created_at?: string;
  updated_at?: string;
  next_attempt_at?: string | null;
};
export type JobCounts = {
  all: number;
  attention: number;
  active: number;
  completed: number;
};
export type JobPage = {
  items: Job[];
  total: number;
  page: number;
  page_size: number;
  counts: JobCounts;
};
export type Suggestion = {
  id?: string;
  status: string;
  existing_folder_id?: string | null;
  proposed_folder_path?: string | null;
  existing_tag_ids: string[];
  new_tag_names: string[];
  short_summary?: string;
  reason: string;
  confidence_hint?: string;
  document_version?: number;
  data?: Record<string, unknown>;
};
export class ApiError extends Error {
  code: string;
  requestId?: string;
  status: number;
  constructor(status: number, body: Record<string, unknown>) {
    const raw = (body.error || body.detail || body) as Record<string, unknown>;
    super(
      String(
        raw.message ||
          (typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body)) ||
          "请求失败",
      ),
    );
    this.code = String(raw.code || "request_failed");
    this.requestId = String(raw.request_id || body.request_id || "");
    this.status = status;
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) {
    let body: Record<string, unknown>;
    try {
      body = await response.json();
    } catch {
      body = { message: `请求失败 (${response.status})` };
    }
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
export function items<T>(
  value: T[] | { items?: T[]; results?: T[]; documents?: T[] },
): T[] {
  return Array.isArray(value)
    ? value
    : value.items || value.results || value.documents || [];
}
export function query(
  params: Record<string, string | number | boolean | null | undefined>,
) {
  const values = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") values.set(k, String(v));
  });
  return values.size ? `?${values}` : "";
}
export const errorText = (error: unknown) =>
  error instanceof ApiError
    ? `${error.message}${error.requestId ? ` · 请求 ${error.requestId}` : ""}`
    : error instanceof Error
      ? error.message
      : "操作失败，请重试";
export function anchorText(c: Citation | Section) {
  const a = c.anchors || ("anchor" in c ? c.anchor : undefined) || {};
  const span = (kind: string, label: string) => {
    const start = anchorNumber(a, `${kind}_start`);
    const end = anchorNumber(a, `${kind}_end`);
    return start
      ? `第 ${start}${end && end !== start ? `–${end}` : ""} ${label}`
      : "";
  };
  const sheet =
    typeof a.sheet_name === "string"
      ? `工作表「${a.sheet_name}」`
      : anchorNumber(a, "sheet_index")
        ? `第 ${a.sheet_index} 张工作表`
        : "";
  const chapter =
    typeof a.chapter_title === "string"
      ? `章节「${a.chapter_title}」`
      : anchorNumber(a, "chapter_index")
        ? `第 ${a.chapter_index} 章`
        : "";
  if (sheet) return [sheet, span("row", "行")].filter(Boolean).join(" · ");
  if (anchorNumber(a, "slide_start")) return span("slide", "张幻灯片");
  if (chapter)
    return [chapter, span("paragraph", "段")].filter(Boolean).join(" · ");
  if (anchorNumber(a, "record_start")) return span("record", "条记录");
  if (anchorNumber(a, "row_start")) return span("row", "行");
  const page =
    c.page_start || anchorNumber(a, "page_start") || anchorNumber(a, "page");
  const line = c.line_start || anchorNumber(a, "line_start");
  const paragraph = c.paragraph_start || anchorNumber(a, "paragraph_start");
  return page
    ? `第 ${page} 页`
    : paragraph
      ? `第 ${paragraph} 段`
      : line
        ? `第 ${line} 行`
        : "原文片段";
}
