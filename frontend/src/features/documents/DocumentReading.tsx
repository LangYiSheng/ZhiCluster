import { useState } from "react";
import { AlignLeft, FileImage, LocateFixed, Quote } from "lucide-react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, Document, Section } from "../../lib/api";
import { anchorText } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Empty, ErrorState, Loading } from "../../components/common";
import { PdfViewer } from "./PdfViewer";
import { PdfNavigation } from "./PdfNavigation";

function CitationFocus({
  citation,
  onLocate,
}: {
  citation: Citation;
  onLocate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <aside className="citation-focus" aria-label="当前引用">
      <div className="row spread">
        <strong>
          <Quote size={13} />
          {anchorText(citation)}
        </strong>
        <div className="row gap">
          <Button
            size="sm"
            variant="ghost"
            onClick={onLocate}
            title="重新定位引用"
          >
            <LocateFixed size={13} />
            定位
          </Button>
          <button
            type="button"
            className="citation-excerpt-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起片段" : "展开片段"}
          </button>
        </div>
      </div>
      <p className={expanded ? "" : "is-compact"}>{citation.snippet}</p>
    </aside>
  );
}

function highlighted(section: Section, citation?: Citation) {
  if (!citation) return false;
  const anchor = citation.anchors || citation.anchor || {};
  const source = section.anchors || section;
  for (const kind of ["page", "paragraph", "line"]) {
    const start = anchor[`${kind}_start`];
    const from = Number(source[`${kind}_start` as keyof typeof source]);
    const to = Number(source[`${kind}_end` as keyof typeof source] || from);
    if (start && from) return from <= start && to >= start;
  }
  return (
    !!citation.snippet &&
    section.plain_text.includes(citation.snippet.slice(0, 40))
  );
}

export function DocumentReading({
  document,
  sections,
  citation,
  page,
  onPageChange,
  loading,
  error,
  retry,
  tasksUrl,
  active,
  onLocate,
}: {
  document: Document;
  sections: Section[];
  citation?: Citation;
  page: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  error: unknown;
  retry: () => void;
  tasksUrl: string;
  active: boolean;
  onLocate: () => void;
}) {
  const [mode, setMode] = useState<"original" | "text">("original");
  const [pdfPages, setPdfPages] = useState(0);
  const pdf = document.ext === "pdf";
  const total =
    pdfPages ||
    Math.max(
      1,
      ...sections.map(
        (section) =>
          section.anchors?.page_end ||
          section.page_end ||
          section.anchors?.page_start ||
          section.page_start ||
          1,
      ),
    );
  const visible = pdf
    ? sections.filter(
        (section) =>
          (section.anchors?.page_start || section.page_start || 1) === page,
      )
    : sections;
  return (
    <div className={`document-reader${pdf ? " is-pdf" : ""}`}>
      {citation?.snippet && (
        <CitationFocus
          key={citation.chunk_id}
          citation={citation}
          onLocate={onLocate}
        />
      )}
      {pdf && (
        <div
          className="reader-view-modes"
          role="tablist"
          aria-label="文档查看方式"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "original"
                : event.key === "End"
                  ? "text"
                  : mode === "original"
                    ? "text"
                    : "original";
            setMode(next);
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)
              ?.focus();
          }}
        >
          <button
            type="button"
            role="tab"
            data-mode="original"
            aria-selected={mode === "original"}
            aria-controls={`reader-original-${document.id}`}
            tabIndex={mode === "original" ? 0 : -1}
            onClick={() => setMode("original")}
          >
            <FileImage size={14} />
            原件
          </button>
          <button
            type="button"
            role="tab"
            data-mode="text"
            aria-selected={mode === "text"}
            aria-controls={`reader-text-${document.id}`}
            tabIndex={mode === "text" ? 0 : -1}
            onClick={() => setMode("text")}
          >
            <AlignLeft size={14} />
            文字
          </button>
        </div>
      )}
      {pdf && (
        <div
          role="tabpanel"
          aria-label="PDF 原件"
          id={`reader-original-${document.id}`}
          hidden={mode !== "original"}
        >
          <PdfViewer
            documentId={document.id}
            page={page}
            onPageChange={onPageChange}
            onPageCount={setPdfPages}
            active={active && mode === "original"}
          />
        </div>
      )}
      <div
        id={`reader-text-${document.id}`}
        role={pdf ? "tabpanel" : undefined}
        aria-label={pdf ? "PDF 文字" : undefined}
        hidden={pdf && mode !== "text"}
      >
        {pdf && (
          <PdfNavigation
            page={page}
            total={total}
            onPageChange={onPageChange}
          />
        )}
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState error={error} retry={retry} />
        ) : !sections.length ? (
          <Empty title="正文暂不可用">
            <Link to={tasksUrl}>查看处理任务</Link>
          </Empty>
        ) : !visible.length ? (
          <p className="pdf-no-text">
            本页没有可提取的文字，可切换到原件查看。
          </p>
        ) : (
          <div className="text-reader">
            {visible.map((section) => (
              <section
                data-section-id={section.id}
                key={section.id}
                className={`text-section ${highlighted(section, citation) ? "highlighted" : ""}`}
              >
                <div className="section-anchor">
                  {section.heading && <strong>{section.heading}</strong>}
                  <small>{anchorText(section)}</small>
                </div>
                {document.ext === "md" ? (
                  <div className="markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                      {section.plain_text}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="plain-text">{section.plain_text}</p>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
