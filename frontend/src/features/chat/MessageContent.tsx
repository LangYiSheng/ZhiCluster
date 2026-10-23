import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation } from "../../lib/api";
import { anchorText } from "../../lib/api";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
};

/** Only text nodes become citations: code, links and HTML remain untouched. */
function citationMarkers() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (
        !node.children ||
        ["code", "inlineCode", "link", "html"].includes(node.type)
      )
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const parts: MarkdownNode[] = [];
        let cursor = 0;
        for (const match of child.value.matchAll(/\[S(\d+)\]/g)) {
          if (match.index > cursor)
            parts.push({
              type: "text",
              value: child.value.slice(cursor, match.index),
            });
          parts.push({
            type: "link",
            url: `#source-${Number(match[1])}`,
            children: [{ type: "text", value: match[1] }],
          });
          cursor = match.index + match[0].length;
        }
        if (!parts.length) return [child];
        if (cursor < child.value.length)
          parts.push({ type: "text", value: child.value.slice(cursor) });
        return parts;
      });
    };
    visit(tree);
  };
}

export const MessageContent = memo(function MessageContent({
  content,
  citations = [],
  onCitation,
}: {
  content: string;
  citations?: Citation[];
  onCitation: (citation: Citation) => void;
}) {
  const byOrdinal = new Map(
    citations.map((citation) => [citation.ordinal, citation]),
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, citationMarkers]}
        skipHtml
        components={{
          a: ({ href, children, title }) => {
            const marker = /^#source-(\d+)$/.exec(href || "");
            if (!marker)
              return (
                <a href={href} title={title}>
                  {children}
                </a>
              );
            const ordinal = Number(marker[1]);
            const citation = byOrdinal.get(ordinal);
            const unavailable = !citation || citation.available === false;
            return (
              <button
                type="button"
                className="citation-marker"
                disabled={unavailable}
                aria-label={
                  unavailable
                    ? `引用 ${ordinal} 不可用`
                    : `查看来源 ${ordinal}：${citation.document_name || citation.display_name || "原文"}`
                }
                title={
                  unavailable
                    ? "来源已删除、不可访问或引用无效"
                    : `${citation.document_name || citation.display_name || "查看原文"} · ${anchorText(citation)}`
                }
                onClick={() => citation && !unavailable && onCitation(citation)}
              >
                {ordinal}
              </button>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export const CitationList = memo(function CitationList({
  content,
  citations = [],
  onCitation,
}: {
  content: string;
  citations?: Citation[];
  onCitation: (citation: Citation) => void;
}) {
  const ordinals = new Set(
    [...content.matchAll(/\[S(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const sources = citations.filter((citation) =>
    ordinals.has(citation.ordinal || 0),
  );
  if (!sources.length) return null;
  return (
    <div className="citations" aria-label="回答来源">
      <span className="tiny muted">来源</span>
      <ol>
        {sources.map((citation) => (
          <li key={`${citation.ordinal}-${citation.chunk_id}`}>
            <button
              type="button"
              disabled={citation.available === false}
              title={
                citation.available === false
                  ? "来源已删除或无权访问"
                  : citation.document_name || citation.display_name
              }
              onClick={() => onCitation(citation)}
            >
              <span className="source-number">{citation.ordinal}</span>
              <span className="source-title">
                {citation.document_name || citation.display_name || "查看原文"}
              </span>
              <small>
                {citation.available === false
                  ? "来源不可用"
                  : anchorText(citation)}
              </small>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
});
