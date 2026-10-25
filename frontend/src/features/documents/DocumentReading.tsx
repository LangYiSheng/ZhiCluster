import { useState } from "react";
import { AlignLeft, FileImage, LocateFixed, Quote } from "lucide-react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, Document, Section } from "../../lib/api";
import { anchorText } from "../../lib/api";
import {
  anchorNumber,
  hasSourceAnchor,
  matchesSourceAnchor,
} from "../../lib/sourceAnchors";
import type { SourceAnchors } from "../../lib/sourceAnchors";
import { Button } from "../../components/ui/button";
import { Empty, ErrorState, Loading } from "../../components/common";
import { PdfViewer } from "./PdfViewer";
import { PdfNavigation } from "./PdfNavigation";
import "./document-reading.css";

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
  const anchor = citation.anchors ||
    citation.anchor || {
      ...(citation.page_start ? { page_start: citation.page_start } : {}),
      ...(citation.paragraph_start
        ? { paragraph_start: citation.paragraph_start }
        : {}),
      ...(citation.line_start ? { line_start: citation.line_start } : {}),
    };
  const source = section.anchors || section;
  if (hasSourceAnchor(anchor))
    return matchesSourceAnchor(source as SourceAnchors, anchor);
  return (
    !!citation.snippet &&
    section.plain_text.includes(citation.snippet.slice(0, 40))
  );
}

function TextSection({
  section,
  citation,
  markdown,
}: {
  section: Section;
  citation?: Citation;
  markdown: boolean;
}) {
  const anchors = section.anchors || {};
  const structured = [
    "sheet_index",
    "sheet_name",
    "slide_start",
    "row_start",
    "record_start",
    "chapter_index",
    "chapter_title",
  ].some((key) => anchors[key] !== undefined);
  const heading = (
    <span className="section-anchor">
      {section.heading && <strong>{section.heading}</strong>}
      <small>{anchorText(section)}</small>
    </span>
  );
  const content = markdown ? (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {section.plain_text}
      </ReactMarkdown>
    </div>
  ) : (
    <p className="plain-text">{section.plain_text}</p>
  );
  return (
    <section
      data-section-id={section.id}
      className={`text-section ${highlighted(section, citation) ? "highlighted" : ""}`}
    >
      {structured ? (
        <details className="structured-text-section" open>
          <summary>{heading}</summary>
          {content}
        </details>
      ) : (
        <>
          {heading}
          {content}
        </>
      )}
    </section>
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
  const [navigation, setNavigation] = useState({
    documentId: "",
    citationKey: "",
    index: 0,
  });
  const pdf = document.preview_type
    ? document.preview_type === "pdf"
    : document.ext === "pdf";
  const citationKey = citation
    ? `${citation.chunk_id}:${JSON.stringify(citation.anchors || citation.anchor || {})}`
    : "";
  const targetIndex = citation
    ? sections.findIndex((section) => highlighted(section, citation))
    : -1;
  const lastSectionPage = Math.max(0, Math.ceil(sections.length / 40) - 1);
  const sectionPage = Math.min(
    lastSectionPage,
    navigation.documentId === document.id &&
      navigation.citationKey === citationKey
      ? navigation.index
      : targetIndex >= 0
        ? Math.floor(targetIndex / 40)
        : 0,
  );
  function setSectionPage(index: number) {
    setNavigation({ documentId: document.id, citationKey, index });
  }
  function locateCitation() {
    if (!pdf && targetIndex >= 0) setSectionPage(Math.floor(targetIndex / 40));
    onLocate();
  }
  const total = !pdf
    ? 1
    : pdfPages ||
      sections.reduce(
        (largest, section) =>
          Math.max(
            largest,
            anchorNumber(section.anchors, "page_end") ||
              section.page_end ||
              anchorNumber(section.anchors, "page_start") ||
              section.page_start ||
              1,
          ),
        1,
      );
  const visible = pdf
    ? sections.filter(
        (section) =>
          (anchorNumber(section.anchors, "page_start") ||
            section.page_start ||
            1) === page,
      )
    : sections.slice(sectionPage * 40, (sectionPage + 1) * 40);
  return (
    <div className={`document-reader${pdf ? " is-pdf" : ""}`}>
      {citation?.snippet && (
        <CitationFocus
          key={citation.chunk_id}
          citation={citation}
          onLocate={locateCitation}
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
        {!pdf && !["txt", "md"].includes(document.ext) && (
          <p className="document-text-preview-note">
            显示提取的正文与来源位置；完整排版请下载原文件。
          </p>
        )}
        {!pdf && sections.length > 40 && (
          <nav
            className="pagination document-section-pagination"
            aria-label="正文分段分页"
          >
            <Button
              size="sm"
              disabled={sectionPage === 0}
              onClick={() => setSectionPage(sectionPage - 1)}
            >
              上一组
            </Button>
            <small>
              {sectionPage * 40 + 1}–
              {Math.min(sections.length, (sectionPage + 1) * 40)} /{" "}
              {sections.length} 节
            </small>
            <Button
              size="sm"
              disabled={sectionPage === lastSectionPage}
              onClick={() => setSectionPage(sectionPage + 1)}
            >
              下一组
            </Button>
          </nav>
        )}
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
              <TextSection
                key={section.id}
                section={section}
                citation={citation}
                markdown={document.ext === "md"}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
