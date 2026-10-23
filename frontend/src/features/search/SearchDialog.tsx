import { useEffect, useRef, useState } from "react";
import { Search, ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, anchorText } from "../../lib/api";
import type { Citation, SearchResponse } from "../../lib/api";
import { Dialog } from "../../components/ui/dialog";
import { Empty, ErrorState, Loading } from "../../components/common";
import { retrievalNotice } from "./retrievalNotice";
export function SearchDialog({
  open,
  onOpenChange,
  kbId,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  kbId: string;
  onOpen: (c: Citation) => void;
}) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(id);
  }, [text]);
  const result = useQuery({
    queryKey: ["search", kbId, debounced],
    queryFn: () =>
      api<SearchResponse>("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: debounced,
          kb_ids: [kbId],
          mode: "hybrid",
          limit: 25,
        }),
      }),
    enabled: open && !!kbId && !!debounced.trim(),
  });
  const rows = result.data?.items || [];
  const notice = retrievalNotice(result.data?.notice);
  function choose(index: number) {
    const item = rows[index];
    if (item) {
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
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((n) => Math.min(rows.length - 1, n + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((n) => Math.max(0, n - 1));
            }
            if (e.key === "Enter") choose(selected);
          }}
        />
        <kbd>ESC</kbd>
      </div>
      {notice && <p className="search-mode muted">{notice}</p>}
      <div className="search-results" role="listbox" aria-label="搜索结果">
        {result.isFetching ? (
          <Loading />
        ) : result.isError ? (
          <ErrorState
            error={result.error}
            retry={() => void result.refetch()}
          />
        ) : !debounced ? (
          <Empty title="从一个关键词开始">支持中文标题与文档正文</Empty>
        ) : !rows.length ? (
          <Empty title="没有找到相关内容">
            换一个关键词试试，或检查当前知识库范围。
          </Empty>
        ) : (
          rows.map((row, i) => (
            <button
              type="button"
              role="option"
              aria-selected={selected === i}
              className={`search-result ${selected === i ? "selected" : ""}`}
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
