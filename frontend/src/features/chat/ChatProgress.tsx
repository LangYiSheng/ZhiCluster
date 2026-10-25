import { BookOpen, Check, ChevronDown, CircleAlert, Compass, Files, FolderSearch, ListTree, LoaderCircle, Search } from "lucide-react";
import { anchorText } from "../../lib/api";
import type { ChatStep, Citation, Message } from "../../lib/api";
import { CitationPreview } from "./CitationPreview";
import { isMessageBusy } from "./chatEvents";
import "./chat-progress.css";

type SearchRound = {
  key: string;
  round: number;
  scope: string;
  queries: string[];
  status: ChatStep["status"];
  count?: number;
  summarized: boolean;
};

const searchStages = new Set(["search", "search_result", "search_round_summary"]);
const legacyStages = new Set(["keyword", "embedding", "ranking", "context"]);

function searchRounds(steps: ChatStep[]) {
  const rounds = new Map<string, SearchRound>();
  const explicit = steps.some((step) => searchStages.has(step.stage));
  let currentRound = 1;
  for (const step of steps) {
    if (step.stage === "tool_activity") continue;
    if (typeof step.round === "number" && Number.isInteger(step.round) && step.round > 0)
      currentRound = step.round;
    const count = typeof step.source_count === "number" && Number.isInteger(step.source_count) && step.source_count >= 0
      ? step.source_count
      : undefined;
    if (explicit ? !searchStages.has(step.stage) : !legacyStages.has(step.stage) && !step.query)
      continue;
    // Legacy messages have only a final context count, not a deduplicated
    // per-round total. Reuse it only for one recorded search group.
    if (!explicit && step.stage === "context" && rounds.size) {
      if (rounds.size === 1 && count !== undefined)
        rounds.values().next().value!.count = count;
      continue;
    }
    const scope = typeof step.scope_label === "string" && step.scope_label.trim()
      ? step.scope_label
      : "当前知识范围";
    const round = currentRound;
    const key = round + ":" + (typeof step.scope_key === "string" && step.scope_key ? step.scope_key : scope);
    const status = step.status === "running" || step.status === "failed" ? step.status : "completed";
    let group = rounds.get(key);
    if (!group) {
      group = { key, round, scope, queries: [], status, summarized: false };
      rounds.set(key, group);
    }
    const queryValues = Array.isArray(step.queries)
      ? step.queries
      : typeof step.query === "string" ? [step.query] : [];
    const queries = queryValues
      .filter((query) => typeof query === "string" && query.trim())
      .map((query) => query.trim());
    group.queries = [...new Set([...group.queries, ...queries])];
    if (step.stage === "search") {
      group.summarized = false;
      group.status = status;
      group.count = status === "completed" && group.queries.length === 1
        ? count
        : undefined;
    } else if (step.stage === "search_round_summary") {
      group.summarized = true;
      group.status = status;
      group.queries = [...new Set(queries)];
      group.count = count;
    } else if (!group.summarized) {
      group.status = step.stage === "search_result" ? "completed" : status;
      if (group.queries.length <= 1 && count !== undefined)
        group.count = count;
      else if (group.queries.length > 1) group.count = undefined;
    }
  }
  return [...rounds.values()];
}

function LegacyProgress({ message }: { message: Message }) {
  const busy = isMessageBusy(message);
  const execution = message.retrieval?.execution;
  const steps = Array.isArray(execution)
    ? execution.filter((step) => step && typeof step === "object" && !Array.isArray(step) && typeof step.stage === "string")
    : [];
  const rounds = searchRounds(steps);
  const fallback = fallbackFrom(steps);
  if (!busy && !rounds.length && !fallback) return null;
  const failed = message.status === "failed";
  const label = busy
    ? steps.at(-1)?.stage === "generation"
      ? "正在生成回答"
      : message.status === "queued"
        ? "等待查阅资料"
        : "正在查找资料"
    : failed
      ? "资料查阅未完成"
      : "已完成资料查阅";
  const mode = message.retrieval?.retrieval_mode;
  const title = mode === "model" ? "思考过程" : mode === "direct" ? "快速查阅" : label;
  const icon = busy ? (
    <LoaderCircle className="progress-spinner" size={14} />
  ) : failed ? (
    <CircleAlert size={14} />
  ) : (
    <Check size={14} />
  );
  if (!rounds.length && !fallback)
    return (
      <div className="chat-progress chat-progress-waiting" role="status">
        {icon}<span>{label}</span>
      </div>
    );
  return (
    <details className={"chat-progress" + (busy ? " is-running" : "")}>
      <summary>
        {icon}
        <span aria-live="polite">{title}</span>
        <small className="progress-call-count" aria-live="polite">
          {fallback && !busy && !failed ? `${fallback.label}${rounds.length ? " · " : ""}` : mode && `${busy ? "查阅中" : failed ? "未完成" : "已完成"} · `}
          {rounds.length > 0 && <>{new Set(rounds.map((round) => round.round)).size} 轮查阅</>}
        </small>
        <ChevronDown size={13} className="progress-chevron" />
      </summary>
      {fallback && <FallbackNotice notice={fallback.notice} />}
      <ol className="chat-search-rounds" aria-label="资料查阅过程">
        {rounds.map((round) => (
          <li className="chat-search-round" key={round.key} data-round={round.round}>
            <div className="chat-search-heading">
              <Search size={13} aria-hidden="true" />
              <span>在{round.scope}中查找相关资料</span>
            </div>
            {!!round.queries.length && (
              <div className="chat-search-queries" role="list" aria-label="检索词">
                {round.queries.map((query) => (
                  <span role="listitem" className="chat-search-query" key={query}>{query}</span>
                ))}
              </div>
            )}
            <p className={"chat-search-count" + (round.status === "failed" ? " is-failed" : "")}>
              {typeof round.count === "number"
                ? "已检索到 " + round.count + " 条信息"
                : round.status === "failed" || failed
                  ? "此次查找未完成"
                  : busy && round.status === "running"
                    ? "正在检索…"
                    : "已完成检索"}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}

const toolLabels = {
  search_knowledge: { label: "知识库搜索", icon: Search },
  get_current_scope: { label: "查看问答范围", icon: Compass },
  list_scope_metadata: { label: "查找目录与标签", icon: FolderSearch },
  list_documents: { label: "查找文档", icon: Files },
  get_document_outline: { label: "浏览文档目录", icon: ListTree },
  read_document: { label: "阅读原文", icon: BookOpen },
};
type ToolName = keyof typeof toolLabels;
type ToolActivity = ChatStep & { key: string; tool_name: ToolName };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

const fallbackNotices = new Map([
  ["模型检索规划暂不可用，已沿用直接检索", { label: "已转为直接查阅", notice: "模型检索规划暂不可用，已沿用直接检索" }],
  ["模型未提供检索词，已使用原问题直接检索", { label: "已转为直接查阅", notice: "模型未提供检索词，已使用原问题直接检索" }],
  ["部分检索暂不可用，已保留已找到的资料", { label: "已沿用可用资料", notice: "部分检索暂不可用，已保留已找到的资料" }],
  ["检索暂不可用，本次未扩大筛选范围或重复相同搜索", { label: "已停止查阅", notice: "检索暂不可用，本次未扩大筛选范围或重复相同搜索" }],
]);

function fallbackFrom(steps: ChatStep[]) {
  const fallback = [...steps].reverse().find((step) => step.stage === "retrieval_fallback");
  if (!fallback) return undefined;
  const known = fallbackNotices.get(text(fallback.notice));
  if (known) return known;
  const direct = fallback.label === "已转为直接检索" || steps.some((step) => step.call_id === "tool-fallback-search");
  const kept = steps.some((step) => step.available !== false && step.status === "completed" && (count(step.source_count) || 0) > 0);
  const label = direct ? "已转为直接查阅" : kept ? "已沿用可用资料" : "查阅流程已调整";
  const code = text(fallback.error_code);
  const reason = code.endsWith("_timeout") ? "工具规划响应超时" : code === "planning_budget_exhausted" ? "本次工具规划已达到时间预算" : "工具规划暂不可用";
  // Only known server notices and fixed error-code summaries are public.
  // Old/provider exception text must not become a process explanation.
  return { label, notice: `${reason}，${label}。` };
}

function FallbackNotice({ notice }: { notice: string }) {
  return <p className="chat-retrieval-fallback" role="status"><CircleAlert size={13} aria-hidden="true" /><span>{notice}</span></p>;
}

function activitiesFrom(steps: ChatStep[]) {
  const activities = new Map<string, ToolActivity>();
  for (const [index, step] of steps.entries()) {
    if (step.stage !== "tool_activity" || !Object.hasOwn(toolLabels, text(step.tool_name))) continue;
    const tool = step.tool_name as ToolName;
    const key = text(step.call_id) || `${tool}:${step.round || 1}:${index}`;
    // A completion is the authoritative snapshot. Do not carry a source or
    // old name forward if a later permission check removed those fields.
    activities.set(key, {
      ...step,
      key,
      tool_name: tool,
      status: step.status === "running" || step.status === "failed" ? step.status : "completed",
    });
  }
  return [...activities.values()];
}

function availableSource(value: unknown): Citation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Citation;
  return source.available !== false && text(source.document_id) && text(source.chunk_id) ? source : undefined;
}

function activityCount(activity: ToolActivity) {
  if (activity.status === "failed") return "未完成";
  if (activity.status === "running") return "进行中";
  const sources = count(activity.source_count);
  const results = count(activity.result_count);
  if (activity.tool_name === "search_knowledge" && sources !== undefined) return `${sources} 条相关片段`;
  if (activity.tool_name === "read_document" && sources !== undefined) return `已读 ${sources} 个片段`;
  if (activity.tool_name === "list_documents" && results !== undefined) return `${results} 份资料`;
  if (results !== undefined) return `${results} 个条目`;
  return "已完成";
}

function ActivityRow({ activity, onOpenSource }: { activity: ToolActivity; onOpenSource?: (source: Citation) => void }) {
  const unavailable = activity.available === false || activity.source?.available === false;
  const source = unavailable || activity.status !== "completed" ? undefined : availableSource(activity.source);
  const query = unavailable ? "" : text(activity.query);
  const documentName = unavailable ? "" : text(source?.document_name) || text(source?.display_name) || text(activity.document_name);
  const detail = unavailable ? "" : text(activity.detail).slice(0, 300);
  const scope = unavailable ? "" : text(activity.scope_label);
  const Icon = toolLabels[activity.tool_name].icon;
  const status = unavailable ? "不可用" : activityCount(activity);
  return (
    <li className={`chat-tool-activity is-${activity.status}${unavailable ? " is-unavailable" : ""}`} data-tool={activity.tool_name}>
      <details className="chat-activity-details">
        <summary>
          {activity.status === "running" ? <LoaderCircle size={13} className="progress-spinner" aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
          <span className="chat-activity-title">{unavailable ? "资料已不可用" : toolLabels[activity.tool_name].label}</span>
          {query ? <span className="chat-activity-query">{query}</span> : !source && documentName ? <span className="chat-activity-query">{documentName}</span> : null}
          <small className="chat-activity-status">{status}</small>
          <ChevronDown size={12} className="activity-chevron" aria-hidden="true" />
        </summary>
        <div className="chat-activity-content">
          {scope && <p className="chat-activity-scope">范围 · {scope}</p>}
          {query && <p className="chat-activity-full-query">{query}</p>}
          {detail && <p>{detail}</p>}
          {source && text(source.snippet) && <blockquote>{text(source.snippet)}</blockquote>}
          {unavailable && <p>来源已删除、移出当前范围或不可访问。</p>}
          {activity.status === "failed" && !unavailable && <p>此次查阅未完成，已保留其他可用结果。</p>}
        </div>
      </details>
      {source && onOpenSource && (
        <div className="chat-activity-source">
          <span>已浏览</span>
          <CitationPreview citation={source} label={`打开查阅原文：${documentName || "原文"}`} className="chat-activity-document" onCitation={onOpenSource}>
            <span>{documentName || "原文"}</span>
            {anchorText(source) && <small>{anchorText(source)}</small>}
          </CitationPreview>
        </div>
      )}
    </li>
  );
}

export function ChatProgress({ message, onOpenSource }: { message: Message; onOpenSource?: (source: Citation) => void }) {
  const execution = message.retrieval?.execution;
  const steps = Array.isArray(execution)
    ? execution.filter((step) => step && typeof step === "object" && !Array.isArray(step) && typeof step.stage === "string")
    : [];
  const activities = activitiesFrom(steps);
  if (!activities.length) return <LegacyProgress message={message} />;
  const busy = isMessageBusy(message);
  const failed = message.status === "failed";
  const fallback = fallbackFrom(steps);
  const mode = message.retrieval?.retrieval_mode;
  const title = mode === "model" ? "思考过程" : mode === "direct" ? "快速查阅" : "资料查阅过程";
  const status = busy
    ? steps.at(-1)?.stage === "generation" ? "正在整理回答" : "正在查阅"
    : failed ? "未完成" : fallback?.label || "已完成";
  const rounds = searchRounds(steps);
  const hasSearchActivities = activities.some((activity) => activity.tool_name === "search_knowledge");
  return (
    <details
      className={`chat-progress chat-activity-progress${busy ? " is-running" : ""}`}
      open={busy || undefined}
      onToggle={(event) => {
        const details = event.currentTarget;
        if (!details.open && details.contains(document.activeElement))
          (details.firstElementChild as HTMLElement | null)?.focus();
      }}
    >
      <summary>
        {busy ? <LoaderCircle size={14} className="progress-spinner" aria-hidden="true" /> : failed ? <CircleAlert size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
        <span>{title}</span>
        <small className="progress-call-count" aria-live="polite">{status} · {activities.length} 项查阅</small>
        <ChevronDown size={13} className="progress-chevron" aria-hidden="true" />
      </summary>
      {fallback && <FallbackNotice notice={fallback.notice} />}
      <ol className="chat-activity-list" aria-label="资料查阅过程">
        {activities.map((activity) => <ActivityRow key={activity.key} activity={activity} onOpenSource={onOpenSource} />)}
      </ol>
      {!hasSearchActivities && rounds.length > 0 && <LegacyProgress message={{ ...message, retrieval: { ...message.retrieval, retrieval_mode: undefined } }} />}
    </details>
  );
}
