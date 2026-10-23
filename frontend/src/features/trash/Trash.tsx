import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Empty, ErrorState, Loading } from "../../components/common";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { api, errorText, json, query } from "../../lib/api";
import "./trash.css";

type TrashKind = "document" | "folder" | "knowledge_base";
type TrashItem = {
  id: string;
  name: string;
  kb_id: string;
  kb_name: string;
  deleted_at: string;
  kind: TrashKind;
  document_count?: number;
  folder_count?: number;
};
type TrashPage = {
  items: TrashItem[];
  total: number;
  counts: Record<TrashKind, number>;
  pending_file_cleanup?: number;
};
type PurgeResult = { pending_file_cleanup: number };
type PurgeTarget = { kind: "all" } | { kind: TrashKind; item: TrashItem };

const kinds: { id: TrashKind; label: string }[] = [
  { id: "document", label: "文档" },
  { id: "folder", label: "文件夹" },
  { id: "knowledge_base", label: "知识库" },
];
const restorePaths: Record<TrashKind, string> = {
  document: "documents",
  folder: "folders",
  knowledge_base: "knowledge-bases",
};
const PAGE_SIZE = 30;

function ItemIcon({ kind }: { kind: TrashKind }) {
  return kind === "knowledge_base" ? (
    <BookOpen size={19} />
  ) : kind === "folder" ? (
    <Folder size={19} />
  ) : (
    <FileText size={19} />
  );
}

function itemContents(item: TrashItem) {
  const parts: string[] = [];
  if (item.document_count !== undefined)
    parts.push(`${item.document_count} 个文档`);
  if (item.folder_count) parts.push(`${item.folder_count} 个文件夹`);
  return parts.join(" · ");
}

function formatDeletedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

export function Trash() {
  const client = useQueryClient();
  const tabsId = useId();
  const [kind, setKind] = useState<TrashKind>("document");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget | null>(null);
  useEffect(() => {
    if (search.trim() === searchQuery) return;
    const timer = window.setTimeout(() => {
      setSearchQuery(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, searchQuery]);
  const trash = useQuery({
    queryKey: ["trash", kind, searchQuery, page],
    queryFn: ({ signal }) =>
      api<TrashPage>(
        `/trash${query({ kind, q: searchQuery, page, page_size: PAGE_SIZE })}`,
        { signal },
      ),
  });
  const changed = async () => {
    setPage(1);
    await Promise.all(
      [
        "trash",
        "knowledge-bases",
        "deleted-kbs",
        "documents",
        "folders",
        "deleted-folders",
        "tasks",
        "jobs",
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
  };
  const restore = useMutation({
    mutationFn: (item: TrashItem) =>
      api(`/${restorePaths[item.kind]}/${item.id}/restore`, json("POST")),
    onSuccess: async (_, item) => {
      await changed();
      toast.success(`已恢复“${item.name}”`);
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const purge = useMutation({
    mutationFn: (target: PurgeTarget) =>
      api<PurgeResult>(
        "/trash/purge",
        json(
          "POST",
          target.kind === "all"
            ? { kind: "all", confirm: true }
            : { kind: target.kind, ids: [target.item.id], confirm: true },
        ),
      ),
    onSuccess: async (result) => {
      setPurgeTarget(null);
      await changed();
      if (result.pending_file_cleanup > 0) {
        toast.warning(
          `还有 ${result.pending_file_cleanup} 个文件未能彻底删除，可再次清空回收站重试`,
        );
      } else toast.success("已永久删除");
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const counts = trash.data?.counts;
  const totalDeleted = counts
    ? counts.document + counts.folder + counts.knowledge_base
    : 0;
  const pendingFiles = trash.data?.pending_file_cleanup || 0;
  const pageCount = Math.max(
    1,
    Math.ceil((trash.data?.total || 0) / PAGE_SIZE),
  );
  const busy = restore.isPending || purge.isPending;
  const chooseKind = (next: TrashKind) => {
    setKind(next);
    setPage(1);
    restore.reset();
  };
  const openPurge = (target: PurgeTarget) => {
    purge.reset();
    setPurgeTarget(target);
  };
  return (
    <section className="trash-page">
      <header className="trash-heading">
        <div>
          <h1>回收站</h1>
          <p>恢复后可继续使用；永久删除后无法找回。</p>
        </div>
        <div className="trash-heading-actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新回收站"
            disabled={trash.isFetching || busy}
            onClick={() => void trash.refetch()}
          >
            <RefreshCw size={16} className={trash.isFetching ? "spin" : ""} />
          </Button>
          <Button
            variant="danger"
            disabled={
              (!totalDeleted && !pendingFiles) ||
              busy ||
              trash.isPending ||
              trash.isError
            }
            onClick={() => openPurge({ kind: "all" })}
          >
            <Trash2 size={15} />
            清空回收站
          </Button>
        </div>
      </header>
      <div className="trash-toolbar">
        <div className="trash-tabs" role="tablist" aria-label="回收站分类">
          {kinds.map((tab, index) => (
            <button
              key={tab.id}
              id={`${tabsId}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-label={`${tab.label}${counts ? ` ${counts[tab.id]}` : ""}`}
              aria-selected={kind === tab.id}
              aria-controls={`${tabsId}-panel`}
              tabIndex={kind === tab.id ? 0 : -1}
              disabled={busy}
              onClick={() => chooseKind(tab.id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % kinds.length
                    : event.key === "ArrowLeft"
                      ? (index + kinds.length - 1) % kinds.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? kinds.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                chooseKind(kinds[next].id);
                document
                  .getElementById(`${tabsId}-tab-${kinds[next].id}`)
                  ?.focus();
              }}
            >
              {tab.label}
              {counts && <span>{counts[tab.id]}</span>}
            </button>
          ))}
        </div>
        <label className="trash-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="搜索已删除的内容"
            placeholder="搜索名称"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div
        className="trash-content"
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-${kind}`}
        tabIndex={0}
      >
        {pendingFiles > 0 && (
          <p className="trash-kind-note">
            有 {pendingFiles} 个文件尚未彻底删除，可点击“清空回收站”重试。
          </p>
        )}
        {kind === "knowledge_base" && (
          <p className="trash-kind-note">
            已删除知识库中的文档和文件夹会一并保留，恢复知识库后可继续访问。
          </p>
        )}
        {restore.isError && (
          <p className="trash-action-error" role="alert">
            {errorText(restore.error)}
          </p>
        )}
        {trash.isPending ? (
          <Loading />
        ) : trash.isError ? (
          <ErrorState error={trash.error} retry={() => void trash.refetch()} />
        ) : trash.data.items.length ? (
          <table className="trash-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">原位置</th>
                <th scope="col">删除时间</th>
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {trash.data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="trash-item-name">
                      <span className="trash-item-icon" aria-hidden="true">
                        <ItemIcon kind={item.kind} />
                      </span>
                      <div>
                        <strong title={item.name}>{item.name}</strong>
                        {itemContents(item) && (
                          <span className="trash-item-contents">
                            {itemContents(item)}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="trash-item-location" title={item.kb_name}>
                    {item.kind === "knowledge_base"
                      ? "个人知识库"
                      : item.kb_name}
                  </td>
                  <td className="trash-item-date">
                    <time dateTime={item.deleted_at}>
                      {formatDeletedAt(item.deleted_at)}
                    </time>
                  </td>
                  <td>
                    <div className="trash-item-actions">
                      <Button
                        size="sm"
                        disabled={busy}
                        aria-label={`恢复 ${item.name}`}
                        onClick={() => restore.mutate(item)}
                      >
                        <RotateCcw size={13} />
                        恢复
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={`永久删除 ${item.name}`}
                        onClick={() => openPurge({ kind: item.kind, item })}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            title={
              searchQuery
                ? "没有找到匹配的内容"
                : `没有已删除的${kinds.find((tab) => tab.id === kind)!.label}`
            }
            icon={<Trash2 size={25} />}
          />
        )}
      </div>
      {trash.data && trash.data.total > 0 && (
        <footer className="trash-pagination">
          <span>共 {trash.data.total} 项</span>
          <div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="上一页"
              disabled={page <= 1 || trash.isFetching}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={16} />
            </Button>
            <span>
              {page} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="下一页"
              disabled={page >= pageCount || trash.isFetching}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        </footer>
      )}
      <Dialog
        open={purgeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !purge.isPending) setPurgeTarget(null);
        }}
        title={
          purgeTarget?.kind === "all" ? "清空回收站？" : "永久删除这项内容？"
        }
        description={
          purgeTarget?.kind === "all"
            ? "将永久删除回收站内的全部文档、文件夹和知识库，包括其中的文件。此操作无法撤销。"
            : "将永久删除这项内容及其包含的文件。此操作无法撤销。"
        }
      >
        {purgeTarget && purgeTarget.kind !== "all" && (
          <p className="trash-confirm-name">{purgeTarget.item.name}</p>
        )}
        {purge.isError && (
          <p className="trash-action-error" role="alert">
            {errorText(purge.error)}
          </p>
        )}
        <div className="trash-confirm-actions">
          <Button
            disabled={purge.isPending}
            onClick={() => setPurgeTarget(null)}
          >
            取消
          </Button>
          <Button
            variant="danger"
            disabled={purge.isPending || !purgeTarget}
            onClick={() => {
              if (purgeTarget) purge.mutate(purgeTarget);
            }}
          >
            {purge.isPending ? "正在删除…" : "确认永久删除"}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
