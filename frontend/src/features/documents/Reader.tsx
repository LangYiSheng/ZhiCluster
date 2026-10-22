import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { api, anchorText, errorText, json } from "../../lib/api";
import type {
  Citation,
  Document,
  Folder,
  Job,
  Section,
  Suggestion,
  Tag,
} from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Empty, ErrorState, Loading, Status } from "../../components/common";
import { PdfViewer } from "./PdfViewer";
type SuggestionEnvelope = {
  id: string;
  payload: Suggestion;
  status: string;
  document_version: number;
};
export function Reader({
  documentId,
  citation,
  reader,
  onReader,
  folders,
  tags,
}: {
  documentId: string;
  citation?: Citation;
  reader: boolean;
  onReader: (v: boolean) => void;
  folders: Folder[];
  tags: Tag[];
}) {
  const qc = useQueryClient();
  const body = useRef<HTMLDivElement>(null);
  const doc = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => api<Document>(`/documents/${documentId}`),
    refetchInterval: 4000,
  });
  const content = useQuery({
    queryKey: ["content", documentId],
    queryFn: () =>
      api<{ text: string; sections: Section[] }>(
        `/documents/${documentId}/content`,
      ),
    enabled: !!doc.data && doc.data.parse_status === "ready",
  });
  const jobs = useQuery({
    queryKey: ["document-jobs", documentId],
    queryFn: () => api<Job[]>("/ingestion/jobs"),
    refetchInterval: 4000,
  });
  const suggestion = useQuery({
    queryKey: ["suggestion", documentId],
    queryFn: () =>
      api<SuggestionEnvelope | null>(`/documents/${documentId}/suggestion`),
    enabled: !!doc.data && doc.data.classification_status === "ready",
    retry: false,
  });
  const [edited, setEdited] = useState<Suggestion | null>(null);
  const [page, setPage] = useState(1);
  const activeSuggestion = edited || suggestion.data?.payload;
  const change = useMutation({
    mutationFn: ({
      action,
      payload,
    }: {
      action: string;
      payload?: Suggestion;
    }) =>
      api(
        `/documents/${documentId}/suggestion`,
        json("POST", { action, payload }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries();
      setEdited(null);
      toast.success("建议已保存");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const retry = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api(`/ingestion/jobs/${id}/${action}`, json("POST")),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success("任务已更新");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  useEffect(() => {
    setPage(
      citation?.page_start ||
        citation?.anchors?.page_start ||
        citation?.anchors?.page ||
        1,
    );
  }, [citation]);
  useEffect(() => {
    if (!citation || !content.data || !body.current) return;
    const a = citation.anchors || {};
    const sections = content.data.sections;
    const target = sections.find((s) => {
      const sa = s.anchors || {};
      return a.line_start
        ? sa.line_start <= a.line_start &&
            (sa.line_end || sa.line_start) >= a.line_start
        : a.paragraph_start
          ? sa.paragraph_start <= a.paragraph_start &&
            (sa.paragraph_end || sa.paragraph_start) >= a.paragraph_start
          : a.page_start
            ? sa.page_start === a.page_start
            : false;
    });
    if (target) {
      const element = body.current.querySelector(
        `[data-section-id="${CSS.escape(target.id)}"]`,
      );
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [citation, content.data, reader]);
  if (doc.isPending) return <Loading />;
  if (doc.isError)
    return <ErrorState error={doc.error} retry={() => void doc.refetch()} />;
  if (!doc.data) return null;
  const d = doc.data;
  const relatedJobs =
    jobs.data?.filter((j) => j.document_id === documentId) || [];
  const textSections = content.data?.sections || [];
  return (
    <div className="reader-container">
      <header className="reader-toolbar">
        <div className="row gap">
          <Button
            size="icon"
            variant="ghost"
            aria-label={reader ? "返回文档详情" : "打开阅读器"}
            onClick={() => onReader(!reader)}
          >
            {reader ? <ArrowLeft size={17} /> : <FileText size={17} />}
          </Button>
          <strong>{d.display_name}</strong>
        </div>
        <a
          className="button button-secondary button-sm"
          href={`/api/documents/${documentId}/download`}
        >
          <Download size={14} />
          下载原文件
        </a>
      </header>
      <div className="page-scroll" ref={body}>
        {!reader ? (
          <div className="document-detail">
            <div className={`detail-file-icon file-${d.ext}`}>
              <FileText size={34} />
              <small>{d.ext.toUpperCase()}</small>
            </div>
            <h1>{d.display_name}</h1>
            <p className="muted">
              {d.original_filename} · {(d.size_bytes / 1024).toFixed(1)} KB
            </p>
            <div className="row gap">
              <Status value={d.parse_status} />
              <Button
                size="sm"
                variant="default"
                onClick={() => onReader(true)}
              >
                打开阅读器
              </Button>
            </div>
            <details
              className="detail-section detail-disclosure"
              open={d.parse_status !== "ready"}
            >
              <summary>文档属性与处理状态</summary>
              <div className="document-properties">
                <div>
                  <span>解析状态</span>
                  <Status value={d.parse_status} />
                </div>
                <div>
                  <span>向量索引</span>
                  <Status value={d.index_status} />
                </div>
                <div>
                  <span>AI 摘要</span>
                  <Status value={d.summary_status} />
                </div>
                <div>
                  <span>分类建议</span>
                  <Status value={d.classification_status} />
                </div>
                <div>
                  <span>文件夹</span>
                  <strong>
                    {folders.find((f) => f.id === d.folder_id)?.name ||
                      "未分类"}
                  </strong>
                </div>
                <div>
                  <span>标签</span>
                  <div className="row gap">
                    {d.tag_ids?.map((id) => (
                      <span className="tag-pill" key={id}>
                        {tags.find((t) => t.id === id)?.name || id}
                      </span>
                    ))}
                    {!d.tag_ids?.length && (
                      <span className="muted">尚未添加</span>
                    )}
                  </div>
                </div>
              </div>
            </details>
            <section className="detail-section">
              <h3>
                <Sparkles size={16} />
                内容摘要
              </h3>
              {!!d.summary_metadata?.main_topics?.length && (
                <p className="muted tiny">
                  主题：{d.summary_metadata.main_topics.join(" · ")}
                </p>
              )}
              {!!d.summary_metadata?.keywords?.length && (
                <div className="tag-checks">
                  {d.summary_metadata.keywords.map((word) => (
                    <span className="tag-pill" key={word}>
                      {word}
                    </span>
                  ))}
                </div>
              )}
              {d.detailed_summary || d.short_summary ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {d.detailed_summary || d.short_summary}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="muted">
                  {d.summary_status === "unconfigured" ||
                  d.summary_status === "not_configured"
                    ? "配置聊天模型后，可生成章节摘要与全文摘要。"
                    : "摘要尚未生成。正文解析完成后即可阅读与关键词搜索。"}
                </p>
              )}
            </section>
            {d.error && <p className="notice warning">{d.error}</p>}
            {activeSuggestion && suggestion.data?.status === "pending" && (
              <section className="detail-section suggestion-box">
                <h3>
                  <Sparkles size={16} />
                  智能分类建议
                </h3>
                <p>{activeSuggestion.reason}</p>
                <label>
                  主要文件夹
                  <select
                    value={activeSuggestion.existing_folder_id || ""}
                    onChange={(e) =>
                      setEdited({
                        ...activeSuggestion,
                        existing_folder_id: e.target.value || null,
                        proposed_folder_path: null,
                      })
                    }
                  >
                    <option value="">未分类 / 使用新建建议</option>
                    {folders
                      .filter((f) => !f.deleted_at)
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  建议新文件夹路径
                  <input
                    value={activeSuggestion.proposed_folder_path || ""}
                    onChange={(e) =>
                      setEdited({
                        ...activeSuggestion,
                        proposed_folder_path: e.target.value || null,
                        existing_folder_id: null,
                      })
                    }
                  />
                </label>
                <div className="tag-checks">
                  {tags.map((t) => (
                    <label className="checkbox-label" key={t.id}>
                      <input
                        type="checkbox"
                        checked={
                          activeSuggestion.existing_tag_ids?.includes(t.id) ||
                          false
                        }
                        onChange={(e) =>
                          setEdited({
                            ...activeSuggestion,
                            existing_tag_ids: e.target.checked
                              ? [
                                  ...(activeSuggestion.existing_tag_ids || []),
                                  t.id,
                                ]
                              : (
                                  activeSuggestion.existing_tag_ids || []
                                ).filter((id) => id !== t.id),
                          })
                        }
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
                <label>
                  建议新标签（英文逗号分隔）
                  <input
                    value={activeSuggestion.new_tag_names?.join(", ") || ""}
                    onChange={(e) =>
                      setEdited({
                        ...activeSuggestion,
                        new_tag_names: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <small className="muted">
                  {activeSuggestion.confidence_hint} · 此说明为启发式判断
                </small>
                <div className="row gap">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={change.isPending}
                    onClick={() =>
                      change.mutate({
                        action: "apply",
                        payload: activeSuggestion,
                      })
                    }
                  >
                    <Check size={14} />
                    应用调整后的建议
                  </Button>
                  <Button
                    size="sm"
                    disabled={change.isPending}
                    onClick={() => change.mutate({ action: "reject" })}
                  >
                    <X size={14} />
                    拒绝
                  </Button>
                </div>
              </section>
            )}
            {!!relatedJobs.length && (
              <details
                className="detail-section detail-disclosure"
                open={relatedJobs.some((job) =>
                  ["queued", "running", "failed"].includes(job.status),
                )}
              >
                <summary>处理任务 · {relatedJobs.length} 项</summary>
                {relatedJobs.map((j) => (
                  <div className="job-row" key={j.id}>
                    <div className="row spread">
                      <Status value={j.stage || j.status} />
                      <small>
                        {Math.round(
                          j.progress <= 1 ? j.progress * 100 : j.progress,
                        )}
                        %
                      </small>
                    </div>
                    <progress
                      max={100}
                      value={j.progress <= 1 ? j.progress * 100 : j.progress}
                    />
                    {j.error && <p className="danger tiny">{j.error}</p>}
                    <div className="row gap">
                      {["failed", "partial_ready", "completed"].includes(
                        j.status,
                      ) && (
                        <Button
                          size="sm"
                          disabled={retry.isPending}
                          onClick={() =>
                            retry.mutate({ id: j.id, action: "retry" })
                          }
                        >
                          <RefreshCw size={13} />
                          重试 AI / 失败阶段
                        </Button>
                      )}
                      {j.status === "queued" && (
                        <Button
                          size="sm"
                          disabled={retry.isPending}
                          onClick={() =>
                            retry.mutate({ id: j.id, action: "cancel" })
                          }
                        >
                          取消任务
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </details>
            )}
          </div>
        ) : (
          <div className="document-reader">
            {citation?.snippet && (
              <div className="citation-banner">
                <strong>{anchorText(citation)}</strong>
                <p>{citation.snippet}</p>
              </div>
            )}
            {d.ext === "pdf" && (
              <PdfViewer
                documentId={documentId}
                page={page}
                onPageChange={setPage}
              />
            )}
            {content.isPending && d.parse_status === "ready" ? (
              <Loading />
            ) : content.isError ? (
              <ErrorState
                error={content.error}
                retry={() => void content.refetch()}
              />
            ) : !textSections.length ? (
              <Empty title="正文暂不可用">
                请检查文档处理状态，失败任务可以重试。
              </Empty>
            ) : (
              <div className="text-reader">
                {textSections.map((s) => (
                  <section
                    data-section-id={s.id}
                    key={s.id}
                    className={`text-section ${citation?.snippet && s.plain_text.includes(citation.snippet.slice(0, 40)) ? "highlighted" : ""}`}
                  >
                    <div className="section-anchor">
                      {s.heading && <strong>{s.heading}</strong>}
                      <small>{anchorText(s)}</small>
                    </div>
                    {d.ext === "md" ? (
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                          {s.plain_text}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="plain-text">{s.plain_text}</p>
                    )}
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
