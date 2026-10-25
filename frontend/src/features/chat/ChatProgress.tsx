import { Check, ChevronDown, CircleAlert, LoaderCircle, Search } from "lucide-react";
import type { ChatStep, Message } from "../../lib/api";
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

export function ChatProgress({ message }: { message: Message }) {
  const busy = isMessageBusy(message);
  const execution = message.retrieval?.execution;
  const steps = Array.isArray(execution)
    ? execution.filter((step) => step && typeof step === "object" && !Array.isArray(step) && typeof step.stage === "string")
    : [];
  const rounds = searchRounds(steps);
  if (!busy && !rounds.length) return null;
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
  const icon = busy ? (
    <LoaderCircle className="progress-spinner" size={14} />
  ) : failed ? (
    <CircleAlert size={14} />
  ) : (
    <Check size={14} />
  );
  if (!rounds.length)
    return (
      <div className="chat-progress chat-progress-waiting" role="status">
        {icon}<span>{label}</span>
      </div>
    );
  return (
    <details className={"chat-progress" + (busy ? " is-running" : "")}>
      <summary>
        {icon}
        <span aria-live="polite">{label}</span>
        <small className="progress-call-count">
          {new Set(rounds.map((round) => round.round)).size} 轮查阅
        </small>
        <ChevronDown size={13} className="progress-chevron" />
      </summary>
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
