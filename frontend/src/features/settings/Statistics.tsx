import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import type { KnowledgeBase } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { ErrorState, Loading } from "../../components/common";
import { Field, SettingsSection } from "./SettingsFields";

type StatisticsData = Record<
  | "knowledge_bases"
  | "documents"
  | "folders"
  | "tags"
  | "conversations"
  | "messages"
  | "storage_bytes"
  | "chunks"
  | "indexed_documents"
  | "failed_jobs",
  number
>;
const fields = [
  ["knowledge_bases", "知识库"],
  ["documents", "有效文档"],
  ["folders", "文件夹"],
  ["tags", "标签"],
  ["conversations", "历史对话"],
  ["messages", "对话消息"],
  ["chunks", "知识片段"],
  ["indexed_documents", "当前模型已索引"],
  ["failed_jobs", "失败任务"],
] as const;
function storageSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
export function Statistics({
  kbId,
  bases,
}: {
  kbId: string;
  bases: KnowledgeBase[];
}) {
  const [scope, setScope] = useState(kbId || "all");
  const statistics = useQuery({
    queryKey: ["settings-statistics", scope],
    queryFn: () =>
      api<StatisticsData>(
        `/settings/statistics${scope === "all" ? "" : `?kb_id=${encodeURIComponent(scope)}`}`,
      ),
  });
  return (
    <SettingsSection
      title="知识工作区统计"
      description="展示当前可访问知识库的实际数据。切换范围即可查看单库或全部知识库。"
    >
      <div className="zc-statistics-toolbar">
        <Field id="statistics-scope" label="统计范围">
          <Select
            id="statistics-scope"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: "all", label: "全部知识库" },
              ...bases.map((base) => ({
                value: base.id,
                label: `${base.name}${base.id === kbId ? "（当前库）" : ""}`,
              })),
            ]}
          />
        </Field>
        <Button
          type="button"
          disabled={statistics.isFetching}
          onClick={() => void statistics.refetch()}
        >
          <RefreshCw
            size={15}
            className={statistics.isFetching ? "spin" : ""}
          />
          刷新统计
        </Button>
      </div>
      {statistics.isPending ? (
        <Loading />
      ) : statistics.isError ? (
        <ErrorState
          error={statistics.error}
          retry={() => void statistics.refetch()}
        />
      ) : (
        <>
          <dl className="zc-statistics-grid">
            {fields.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{statistics.data[key].toLocaleString("zh-CN")}</dd>
              </div>
            ))}
            <div>
              <dt>原文件体积</dt>
              <dd>{storageSize(statistics.data.storage_bytes)}</dd>
            </div>
          </dl>
          <p className="zc-settings-note">
            统计数随文档处理进度更新。原文件体积按数据库中的文档记录计算，不含数据库和索引自身的磁盘占用。
          </p>
        </>
      )}
    </SettingsSection>
  );
}
