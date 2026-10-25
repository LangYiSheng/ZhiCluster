import { useEffect, useRef, useState } from "react";
import { Search, ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, anchorText } from "../../lib/api";
import type { Citation, SearchResponse, Tag } from "../../lib/api";
import { Dialog } from "../../components/ui/dialog";
import { Select } from "../../components/ui/select";
import { Empty, ErrorState, Loading } from "../../components/common";
import { retrievalNotice } from "./retrievalNotice";
import { useDocumentFormats } from "../../lib/documentFormats";
export function SearchDialog({
  open,
  onOpenChange,
  kbId,
  onOpen,
  tags = [],
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  kbId: string;
  onOpen: (c: Citation) => void;
  tags?: Tag[];
}) {
  const formatCatalog = useDocumentFormats(open);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(0);
  const [ext, setExt] = useState("");
  const [tagFilter, setTagFilter] = useState({ kbId, id: "" });
  const tagId =
    tagFilter.kbId === kbId && tags.some((tag) => tag.id === tagFilter.id)
      ? tagFilter.id
      : "";
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(id);
  }, [text]);
  const result = useQuery({
    queryKey: ["search", kbId, debounced, ext, tagId],
    queryFn: () =>
      api<SearchResponse>("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: debounced,
          kb_ids: [kbId],
          mode: "hybrid",
          limit: 25,
          ...(ext ? { exts: [ext] } : {}),
          ...(tagId ? { tag_ids: [tagId] } : {}),
        }),
      }),
    enabled: open && !!kbId && !!debounced.trim(),
  });
  const waitingForText = text !== debounced;
  const loading = !!text.trim() && (waitingForText || result.isFetching);
  const rows =
    !loading && text.trim() && !result.isError ? result.data?.items || [] : [];
  const activeIndex = Math.min(selected, Math.max(0, rows.length - 1));
  const notice =
    waitingForText || !text.trim()
      ? null
      : retrievalNotice(result.data?.notice);
  function choose(index: number) {
    const item = rows[index];
    if (open && item) {
      onOpen(item);
      onOpenChange(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="搜索知识"
      description="在当前知识库中查找文件名与正文。↑↓ 选择，Enter 打开。"
      wide
    >
      <div className="search-input">
        <Search size={19} />
        <input
          ref={input}
          autoFocus
          aria-label="搜索关键词"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSelected(0);
          }}
          placeholder="搜索你的知识库…"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (rows.length)
                setSelected(Math.min(rows.length - 1, activeIndex + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected(Math.max(0, activeIndex - 1));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              choose(activeIndex);
            }
          }}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="file-filters search-dialog-filters">
        <Select
          aria-label="搜索文件类型"
          value={ext}
          size="sm"
          onValueChange={(value) => {
            setExt(value);
            setSelected(0);
          }}
          options={[
            { value: "", label: "全部类型" },
            ...formatCatalog.formats.map((format) => ({
              value: format.extension,
              label: format.extension.toUpperCase(),
            })),
          ]}
        />
        {!!tags.length && (
          <Select
            aria-label="搜索标签"
            value={tagId}
            size="sm"
            onValueChange={(value) => {
              setTagFilter({ kbId, id: value });
              setSelected(0);
            }}
            options={[
              { value: "", label: "全部标签" },
              ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
            ]}
          />
        )}
      </div>
      {notice && <p className="search-mode muted">{notice}</p>}
      <div className="search-results" role="listbox" aria-label="搜索结果">
        {loading ? (
          <Loading />
        ) : !text.trim() ? (
          <Empty title="从一个关键词开始">支持中文标题与文档正文</Empty>
        ) : result.isError ? (
          <ErrorState
            error={result.error}
            retry={() => void result.refetch()}
          />
        ) : !rows.length ? (
          <Empty title="没有找到相关内容">
            换一个关键词试试，或检查当前知识库范围。
          </Empty>
        ) : (
          rows.map((row, i) => (
            <button
              type="button"
              role="option"
              aria-selected={activeIndex === i}
              className={`search-result ${activeIndex === i ? "selected" : ""}`}
              key={row.chunk_id || `${row.document_id}-${i}`}
              onClick={() => choose(i)}
              onMouseEnter={() => setSelected(i)}
            >
              <div className="row spread">
                <strong>
                  {row.display_name || row.document_name || row.title || "文档"}
                </strong>
                <ArrowUpRight size={15} />
              </div>
              <p>{row.snippet || row.content}</p>
              <small>{anchorText(row)}</small>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
