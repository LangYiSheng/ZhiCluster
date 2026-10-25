import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileText,
  MoreHorizontal,
  Sparkles,
  ListChecks,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, query } from "../../lib/api";
import { anchorNumber, matchesSourceAnchor } from "../../lib/sourceAnchors";
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
import { Menu, MenuItem } from "../../components/ui/menu";
import { ErrorState, Loading, Status } from "../../components/common";
import {
  isActiveJob,
  jobNeedsAttention,
  jobProgress,
  jobStageLabel,
  jobStatusLabel,
} from "../../lib/jobs";
import { DocumentReading } from "./DocumentReading";
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
  active = true,
}: {
  documentId: string;
  citation?: Citation;
  reader: boolean;
  onReader: (v: boolean) => void;
  folders: Folder[];
  tags: Tag[];
  active?: boolean;
}) {
  const navigate = useNavigate();
  const body = useRef<HTMLDivElement>(null);
  const doc = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => api<Document>(`/documents/${documentId}`),
    refetchInterval: active ? 4000 : false,
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
    queryFn: () => api<Job[]>(`/ingestion/jobs?document_id=${documentId}`),
    refetchInterval: active ? 4000 : false,
  });
  const suggestion = useQuery({
    queryKey: ["suggestion", documentId],
    queryFn: () =>
      api<SuggestionEnvelope | null>(`/documents/${documentId}/suggestion`),
    enabled: !!doc.data && doc.data.classification_status === "ready",
    retry: false,
  });
  const [page, setPage] = useState(1);
  const [locate, setLocate] = useState(0);
  useEffect(() => {
    setPage(
      citation?.page_start ||
        anchorNumber(citation?.anchors, "page_start") ||
        anchorNumber(citation?.anchors, "page") ||
        1,
    );
  }, [citation]);
  useEffect(() => {
    if (!active || !citation || !content.data || !body.current) return;
    const a = citation.anchors ||
      citation.anchor || {
        ...(citation.page_start ? { page_start: citation.page_start } : {}),
        ...(citation.paragraph_start
          ? { paragraph_start: citation.paragraph_start }
          : {}),
        ...(citation.line_start ? { line_start: citation.line_start } : {}),
      };
    const sections = content.data.sections;
    const target = sections.find((s) => {
      const sa = s.anchors || {};
      return matchesSourceAnchor(sa, a);
    });
    if (target) {
      const element = body.current.querySelector(
        `[data-section-id="${CSS.escape(target.id)}"]`,
      );
      const folded = element?.querySelector<HTMLDetailsElement>(
        "details.structured-text-section",
      );
      if (folded) folded.open = true;
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [active, citation, content.data, reader, locate]);
  if (doc.isPending) return <Loading />;
  if (doc.isError)
    return <ErrorState error={doc.error} retry={() => void doc.refetch()} />;
  if (!doc.data) return null;
  const d = doc.data;
  const relatedJobs =
    jobs.data?.filter((j) => j.document_id === documentId) || [];
  const activeJobs = relatedJobs.filter(isActiveJob);
  const needsAttention = relatedJobs[0] && jobNeedsAttention(relatedJobs[0]);
  const tasksUrl = `/tasks?kb=${d.kb_id}&document=${documentId}`;
  const reviewUrl = `/review${query({ kb: d.kb_id, filter_kb: d.kb_id, document: documentId, tab: "suggestions" })}`;
  const textSections = content.data?.sections || [];
  return (
    <div className="reader-container">
      <header className="reader-toolbar">
        <div className="row gap">
          <FileText size={17} aria-hidden="true" />
          <strong>{d.display_name}</strong>
        </div>
        <div className="row gap reader-actions">
          <a
            className="button button-secondary button-sm"
            href={`/api/documents/${documentId}/download`}
          >
            <Download size={14} />
            下载原文件
          </a>
          {active && (
            <Menu
              trigger={
                <Button size="icon" variant="ghost" aria-label="文档操作">
                  <MoreHorizontal size={17} />
                </Button>
              }
            >
              <MenuItem onSelect={() => onReader(true)}>阅读正文</MenuItem>
              <MenuItem onSelect={() => onReader(false)}>查看属性</MenuItem>
              {suggestion.data?.status === "pending" && (
                <MenuItem onSelect={() => navigate(reviewUrl)}>
                  审阅分类建议
                </MenuItem>
              )}
              <MenuItem onSelect={() => navigate(tasksUrl)}>
                查看处理任务
              </MenuItem>
            </Menu>
          )}
        </div>
      </header>
      <div className="page-scroll" ref={body}>
        {!reader ? (
          <div className="document-detail">
            <section className="detail-section detail-summary">
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
                <p className="muted">摘要尚未生成</p>
              )}
            </section>
            {!!activeJobs.length && (
              <section
                className="detail-section document-processing"
                aria-label="正在处理的任务"
              >
                <div className="row spread">
                  <h3>正在处理</h3>
                  <Link to={tasksUrl}>查看任务</Link>
                </div>
                {activeJobs.map((job) => (
                  <div className="document-processing-job" key={job.id}>
                    <div className="row spread">
                      <span>{jobStageLabel(job)}</span>
                      <small>{jobStatusLabel(job)}</small>
                    </div>
                    {job.status !== "queued" && job.status !== "retry_wait" && (
                      <progress
                        max={100}
                        value={jobProgress(job)}
                        aria-label={`${jobStageLabel(job)}进度`}
                      />
                    )}
                  </div>
                ))}
              </section>
            )}
            {(needsAttention || d.error) && !activeJobs.length && (
              <Link className="document-task-notice" to={tasksUrl}>
                有任务需要处理，前往任务列表查看与重试
              </Link>
            )}
            {active && suggestion.data?.status === "pending" && (
              <section className="detail-section">
                <h3>
                  <ListChecks size={16} />
                  待审阅的分类建议
                </h3>
                <p className="muted tiny">{suggestion.data.payload.reason}</p>
                <Link
                  className="button button-secondary button-sm"
                  to={reviewUrl}
                >
                  前往整理审阅
                </Link>
              </section>
            )}
            <details className="detail-section detail-disclosure">
              <summary>文档属性</summary>
              <div className="document-properties">
                <div>
                  <span>文件名</span>
                  <strong>{d.original_filename}</strong>
                </div>
                <div>
                  <span>文件大小</span>
                  <strong>{(d.size_bytes / 1024).toFixed(1)} KB</strong>
                </div>
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
                    {d.folder_id
                      ? folders.find((f) => f.id === d.folder_id)?.name ||
                        "文件夹已不可用"
                      : "知识库根目录"}
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
            {!!relatedJobs.length && (
              <details className="detail-section detail-disclosure">
                <summary>处理记录 · {relatedJobs.length} 项</summary>
                <div className="document-task-history">
                  {relatedJobs.map((job) => (
                    <div className="row spread" key={job.id}>
                      <span>{jobStageLabel(job)}</span>
                      <span>{jobStatusLabel(job)}</span>
                    </div>
                  ))}
                  <Link to={tasksUrl}>在任务列表中管理</Link>
                </div>
              </details>
            )}
          </div>
        ) : (
          <DocumentReading
            document={d}
            sections={textSections}
            citation={citation}
            page={page}
            onPageChange={setPage}
            loading={content.isPending && d.parse_status === "ready"}
            error={content.isError ? content.error : null}
            retry={() => void content.refetch()}
            tasksUrl={tasksUrl}
            active={active}
            onLocate={() => {
              setPage(
                citation?.page_start ||
                  anchorNumber(citation?.anchors, "page_start") ||
                  anchorNumber(citation?.anchors, "page") ||
                  1,
              );
              setLocate((value) => value + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
