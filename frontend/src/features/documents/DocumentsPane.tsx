import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDownAZ,
  Check,
  Download,
  FileText,
  FolderOpen,
  ListFilter,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, errorText, json, query } from "../../lib/api";
import type { Document, Folder, Job, KnowledgeBase, Tag } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Menu, MenuItem } from "../../components/ui/menu";
import { Empty, ErrorState, Loading, Status } from "../../components/common";
import { FolderTree } from "./FolderTree";
import type { FolderAction } from "./FolderTree";
type FormState = {
  kind: "folder" | "rename" | "move" | "tags" | "delete";
  name: string;
  folder?: Folder;
  parent_id?: string | null;
  document?: Document;
  ids?: string[];
  tag_ids?: string[];
  tag_mode?: string;
  action?: FolderAction;
};
type UploadItem = { document?: Document; status: string; message?: string };
export function DocumentsPane({
  kb,
  folders,
  tags,
  tagId,
  trash,
  onOpen,
  selectedId,
  onUnclassified,
}: {
  kb: KnowledgeBase;
  folders: Folder[];
  tags: Tag[];
  tagId: string;
  trash: boolean;
  onOpen: (doc: Document, reader?: boolean) => void;
  selectedId: string;
  onUnclassified?: () => void;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [folderId, setFolderId] = useState("");
  const [sort, setSort] = useState("date");
  const [ext, setExt] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<FormState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [duplicateFiles, setDuplicateFiles] = useState<File[]>([]);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [context, setContext] = useState<{
    x: number;
    y: number;
    doc: Document;
  } | null>(null);
  const documents = useQuery({
    queryKey: [
      "documents",
      kb.id,
      folderId,
      tagId,
      trash,
      sort,
      ext,
      status,
      page,
    ],
    queryFn: () =>
      api<{ items: Document[]; total: number; page_size: number }>(
        `/knowledge-bases/${kb.id}/documents${query({ folder_id: folderId || undefined, include_descendants: true, tag_ids: tagId, trash, sort, ext, status, page, page_size: 50 })}`,
      ),
    refetchInterval: (q) =>
      q.state.data?.items.some((d) =>
        ["queued", "parsing", "chunking"].includes(d.parse_status),
      )
        ? 2000
        : 5000,
  });
  const jobs = useQuery({
    queryKey: ["jobs", kb.id],
    queryFn: () => api<Job[]>(`/ingestion/jobs?kb_id=${kb.id}`),
    refetchInterval: 4000,
  });
  const deletedKbs = useQuery({
    queryKey: ["deleted-kbs"],
    queryFn: () =>
      api<KnowledgeBase[]>("/knowledge-bases?include_deleted=true"),
    enabled: trash,
  });
  const rows = documents.data?.items || [];
  const activeFolder = folders.find((f) => f.id === folderId);
  const total = documents.data?.total || 0;
  function refresh() {
    void qc.invalidateQueries();
    setSelected(new Set());
  }
  const action = useMutation({
    mutationFn: async ({
      path,
      method = "POST",
      body,
    }: {
      path: string;
      method?: string;
      body?: unknown;
    }) => api(path, json(method, body)),
    onSuccess: () => {
      refresh();
      setForm(null);
      toast.success("操作已保存");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const upload = useMutation({
    mutationFn: async ({
      files,
      policy = "skip",
    }: {
      files: File[];
      policy?: string;
    }) => {
      const data = new FormData();
      files.forEach((f) => data.append("files", f));
      if (folderId && folderId !== "root") data.append("folder_id", folderId);
      data.append("duplicate_policy", policy);
      return {
        result: await api<{ items: UploadItem[] }>(
          `/knowledge-bases/${kb.id}/uploads`,
          { method: "POST", body: data },
        ),
        files,
      };
    },
    onSuccess: ({ result, files }) => {
      setUploadItems(result.items);
      const duplicates = result.items
        .flatMap((r, i) => (r.status === "duplicate" ? [files[i]] : []))
        .filter((f): f is File => !!f);
      if (duplicates.length) setDuplicateFiles(duplicates);
      const count = result.items.filter((r) => r.status === "queued").length;
      if (count) toast.success(`${count} 个文件已上传，后台正在处理`);
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  function openFolderForm(kind: FolderAction, folder?: Folder) {
    if (kind === "trash" || kind === "restore") {
      if (kind === "trash")
        setForm({
          kind: "delete",
          name: folder?.name || "",
          folder,
          action: kind,
        });
      else action.mutate({ path: `/folders/${folder?.id}/restore` });
      return;
    }
    setForm({
      kind: "folder",
      name: kind === "rename" ? folder?.name || "" : "",
      folder,
      parent_id: kind === "create" ? folder?.id || null : folder?.parent_id,
      action: kind,
    });
  }
  function drop(e: DragEvent, target: string | null) {
    e.preventDefault();
    setDragging(false);
    const docIds = e.dataTransfer.getData("application/x-zhicluster-documents");
    const sourceFolder = e.dataTransfer.getData(
      "application/x-zhicluster-folder",
    );
    if (docIds) {
      action.mutate({
        path: "/documents/batch",
        body: {
          kb_id: kb.id,
          document_ids: JSON.parse(docIds) as string[],
          action: "move",
          folder_id: target,
        },
      });
    } else if (sourceFolder) {
      const f = folders.find((f) => f.id === sourceFolder);
      action.mutate({
        path: `/folders/${sourceFolder}`,
        method: "PATCH",
        body: { parent_id: target, version: f?.version },
      });
    } else if (e.dataTransfer.files.length)
      upload.mutate({ files: Array.from(e.dataTransfer.files) });
  }
  function submit() {
    if (!form) return;
    if (form.kind === "folder") {
      const creating = form.action === "create";
      action.mutate({
        path: creating
          ? `/knowledge-bases/${kb.id}/folders`
          : `/folders/${form.folder?.id}`,
        method: creating ? "POST" : "PATCH",
        body: {
          name: form.action === "move" ? undefined : form.name,
          parent_id: form.parent_id || null,
          version: creating ? undefined : form.folder?.version,
        },
      });
    } else if (form.kind === "rename") {
      action.mutate({
        path: `/documents/${form.document?.id}`,
        method: "PATCH",
        body: { display_name: form.name, version: form.document?.version },
      });
    } else if (form.kind === "delete" && form.folder) {
      action.mutate({ path: `/folders/${form.folder.id}`, method: "DELETE" });
    } else {
      action.mutate({
        path: "/documents/batch",
        body: {
          kb_id: kb.id,
          document_ids: form.ids,
          action: form.kind === "delete" ? "trash" : form.kind,
          folder_id: form.parent_id || null,
          tag_ids: form.tag_ids,
          tag_mode: form.tag_mode || "add",
        },
      });
    }
  }
  function docMenu(doc: Document) {
    return (
      <>
        {trash ? (
          <MenuItem
            onSelect={() =>
              action.mutate({ path: `/documents/${doc.id}/restore` })
            }
          >
            恢复文档
          </MenuItem>
        ) : (
          <>
            <MenuItem onSelect={() => onOpen(doc, true)}>打开阅读器</MenuItem>
            <MenuItem
              onSelect={() =>
                setForm({
                  kind: "rename",
                  name: doc.display_name,
                  document: doc,
                })
              }
            >
              重命名
            </MenuItem>
            <MenuItem
              onSelect={() =>
                setForm({
                  kind: "move",
                  name: "",
                  ids: [doc.id],
                  parent_id: doc.folder_id,
                })
              }
            >
              移动到…
            </MenuItem>
            <MenuItem
              onSelect={() =>
                setForm({
                  kind: "tags",
                  name: "",
                  ids: [doc.id],
                  tag_ids: doc.tag_ids || [],
                  tag_mode: "set",
                })
              }
            >
              设置标签
            </MenuItem>
            <MenuItem
              onSelect={() =>
                window.open(
                  `/api/documents/${doc.id}/download`,
                  "_blank",
                  "noopener",
                )
              }
            >
              下载原文件
            </MenuItem>
            <MenuItem
              danger
              onSelect={() =>
                setForm({
                  kind: "delete",
                  name: doc.display_name,
                  ids: [doc.id],
                })
              }
            >
              移到回收站
            </MenuItem>
          </>
        )}
      </>
    );
  }
  return (
    <section
      className={`documents-pane ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => drop(e, folderId && folderId !== "root" ? folderId : null)}
    >
      <header className="pane-header">
        <div>
          <span className="eyebrow">{trash ? "回收站" : "知识管理"}</span>
          <h2>{kb.name}</h2>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="刷新文件"
          onClick={() => void documents.refetch()}
        >
          <RefreshCw size={16} />
        </Button>
      </header>
      {!trash && (
        <div className="upload-wrap">
          <Button
            variant="default"
            className="upload-button"
            onClick={() => input.current?.click()}
            disabled={upload.isPending}
          >
            <Plus size={17} />
            {upload.isPending ? "上传中…" : "添加知识"}
          </Button>
          <input
            ref={input}
            hidden
            type="file"
            aria-label="上传文档"
            accept=".pdf,.docx,.md,.txt"
            multiple
            onChange={(e) => {
              if (e.target.files?.length)
                upload.mutate({ files: Array.from(e.target.files) });
              e.target.value = "";
            }}
          />
          <p className="tiny muted">PDF、DOCX、Markdown、TXT · 可拖拽上传</p>
        </div>
      )}
      <div className="document-navigation">
        <button
          className={!folderId ? "selected" : ""}
          onClick={() => {
            setFolderId("");
            setPage(1);
            setSelected(new Set());
          }}
        >
          <FileText size={15} />
          全部文档 <span>{!folderId ? total : ""}</span>
        </button>
        {!trash && (
          <button
            className={folderId === "root" ? "selected" : ""}
            onClick={() => {
              setFolderId("root");
              setPage(1);
              onUnclassified?.();
            }}
          >
            <Archive size={15} />
            未分类
          </button>
        )}
      </div>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.stopPropagation();
          drop(e, null);
        }}
        className="folder-root-drop"
      >
        <FolderTree
          folders={folders}
          selected={folderId}
          onSelect={(id) => {
            setFolderId(id);
            setPage(1);
            setSelected(new Set());
          }}
          onAction={openFolderForm}
          onDrop={drop}
          trash={trash}
        />
      </div>
      {trash && !!deletedKbs.data?.some((k) => k.deleted_at) && (
        <details className="deleted-kbs">
          <summary>
            已删除知识库 · {deletedKbs.data.filter((k) => k.deleted_at).length}
          </summary>
          <div className="deleted-kb-list">
            {deletedKbs.data
              .filter((k) => k.deleted_at)
              .map((k) => (
                <div className="row spread" key={k.id}>
                  <span>{k.name}</span>
                  <Button
                    size="sm"
                    onClick={() =>
                      action.mutate({
                        path: `/knowledge-bases/${k.id}/restore`,
                      })
                    }
                  >
                    恢复
                  </Button>
                </div>
              ))}
          </div>
        </details>
      )}
      <div className="document-list-heading">
        <span>
          {activeFolder?.name || (folderId === "root" ? "未分类" : "全部文档")}
          <small>{total} 项</small>
        </span>
        <Menu
          trigger={
            <Button size="icon" variant="ghost" aria-label="排序文件">
              <ArrowDownAZ size={15} />
            </Button>
          }
        >
          {[
            ["date", "按日期"],
            ["name", "按名称"],
            ["type", "按类型"],
          ].map(([key, label]) => (
            <MenuItem key={key} onSelect={() => setSort(key)}>
              {sort === key && <Check size={13} />} {label}
            </MenuItem>
          ))}
        </Menu>
      </div>
      <div className="file-filters">
        <ListFilter size={13} />
        <select
          aria-label="文件类型筛选"
          value={ext}
          onChange={(e) => {
            setExt(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部类型</option>
          {["pdf", "docx", "md", "txt"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select
          aria-label="处理状态筛选"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="ready">已就绪</option>
          <option value="queued">排队中</option>
          <option value="failed">失败</option>
        </select>
      </div>
      <div className="selection-bar">
        <label className="checkbox-label">
          <input
            type="checkbox"
            aria-label="全选当前页"
            checked={!!rows.length && rows.every((d) => selected.has(d.id))}
            onChange={(e) =>
              setSelected(
                e.target.checked ? new Set(rows.map((d) => d.id)) : new Set(),
              )
            }
          />
          {selected.size ? `已选 ${selected.size} 项` : "当前页"}
        </label>
        {!!selected.size && (
          <Menu
            trigger={
              <Button size="sm" variant="ghost">
                <MoreHorizontal size={14} />
                批量操作
              </Button>
            }
          >
            {trash ? (
              <MenuItem
                onSelect={() =>
                  action.mutate({
                    path: "/documents/batch",
                    body: {
                      kb_id: kb.id,
                      document_ids: [...selected],
                      action: "restore",
                    },
                  })
                }
              >
                恢复所选
              </MenuItem>
            ) : (
              <>
                <MenuItem
                  onSelect={() =>
                    setForm({
                      kind: "move",
                      name: "",
                      ids: [...selected],
                      parent_id: null,
                    })
                  }
                >
                  移动所选
                </MenuItem>
                <MenuItem
                  onSelect={() =>
                    setForm({
                      kind: "tags",
                      name: "",
                      ids: [...selected],
                      tag_ids: [],
                      tag_mode: "add",
                    })
                  }
                >
                  批量标签
                </MenuItem>
                <MenuItem
                  danger
                  onSelect={() =>
                    setForm({ kind: "delete", name: "", ids: [...selected] })
                  }
                >
                  删除所选
                </MenuItem>
              </>
            )}
          </Menu>
        )}
      </div>
      <div className="document-list">
        {documents.isPending ? (
          <Loading />
        ) : documents.isError ? (
          <ErrorState
            error={documents.error}
            retry={() => void documents.refetch()}
          />
        ) : !rows.length ? (
          <Empty title={trash ? "回收站很干净" : "这里还没有文档"}>
            <p>
              {trash
                ? "删除的文档可以在这里恢复。"
                : "上传一份文档，让知识在这里生长。"}
            </p>
            {!trash && (
              <Button size="sm" onClick={() => input.current?.click()}>
                <UploadCloud size={14} />
                上传文件
              </Button>
            )}
          </Empty>
        ) : (
          rows.map((doc) => (
            <div
              key={doc.id}
              className={`document-row ${selectedId === doc.id ? "active" : ""} ${selected.has(doc.id) ? "checked" : ""}`}
              draggable={!trash}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/x-zhicluster-documents",
                  JSON.stringify(
                    selected.has(doc.id) ? [...selected] : [doc.id],
                  ),
                );
                e.stopPropagation();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContext({
                  x: Math.min(e.clientX, window.innerWidth - 200),
                  y: Math.min(e.clientY, window.innerHeight - 240),
                  doc,
                });
              }}
            >
              <input
                type="checkbox"
                aria-label={`选择 ${doc.display_name}`}
                checked={selected.has(doc.id)}
                onChange={(e) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(doc.id);
                    else n.delete(doc.id);
                    return n;
                  })
                }
              />
              <button
                className="document-open"
                onClick={() => onOpen(doc)}
                onDoubleClick={() => onOpen(doc, true)}
              >
                <span className={`file-icon file-${doc.ext}`}>
                  <FileText size={19} />
                  <small>{doc.ext.toUpperCase()}</small>
                </span>
                <span className="file-info">
                  <strong>{doc.display_name}</strong>
                  <small>
                    {new Date(doc.created_at).toLocaleDateString("zh-CN")} ·{" "}
                    {formatSize(doc.size_bytes)}
                  </small>
                  <Status value={doc.parse_status} />
                </span>
              </button>
              <Menu
                trigger={
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`${doc.display_name}文档菜单`}
                  >
                    <MoreHorizontal size={15} />
                  </Button>
                }
              >
                {docMenu(doc)}
              </Menu>
            </div>
          ))
        )}
      </div>
      {total > 50 && (
        <div className="pagination">
          <Button
            size="sm"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <small>
            {page} / {Math.ceil(total / 50)}
          </small>
          <Button
            size="sm"
            disabled={page * 50 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      <div className="document-footer">
        <span className="online-dot" />
        <small>文件安全保存在本地</small>
        <span>
          {jobs.data?.filter((j) => ["queued", "running"].includes(j.status))
            .length || 0}{" "}
          项任务
        </span>
      </div>
      {dragging && (
        <div className="drop-overlay">
          <UploadCloud size={40} />
          <strong>放下文件，添加到知识库</strong>
        </div>
      )}
      {!!uploadItems.length && (
        <div className="upload-results">
          <div className="row spread">
            <strong>上传结果</strong>
            <Button
              size="icon"
              variant="ghost"
              aria-label="关闭上传结果"
              onClick={() => setUploadItems([])}
            >
              <X size={13} />
            </Button>
          </div>
          {uploadItems.map((r, i) => (
            <p key={i} className={r.status === "error" ? "danger" : ""}>
              {r.document?.display_name || `文件 ${i + 1}`} ·{" "}
              {r.message ||
                { queued: "已排队", duplicate: "文件已存在，已跳过" }[
                  r.status
                ] ||
                r.status}
            </p>
          ))}
        </div>
      )}
      <Dialog
        open={!!form}
        onOpenChange={(v) => !v && setForm(null)}
        title={
          form?.kind === "folder"
            ? form.action === "create"
              ? "新建文件夹"
              : form.action === "move"
                ? "移动文件夹"
                : "重命名文件夹"
            : form?.kind === "rename"
              ? "重命名文档"
              : form?.kind === "move"
                ? "移动文档"
                : form?.kind === "tags"
                  ? "设置标签"
                  : "移到回收站"
        }
        description={
          form?.kind === "delete"
            ? `将删除 ${form.folder ? "文件夹 " + form.name : `${form.ids?.length || 1} 个文档`}，原文件保留，可在回收站恢复。`
            : undefined
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {(form?.kind === "rename" ||
            (form?.kind === "folder" && form.action !== "move")) && (
            <label>
              名称
              <input
                required
                autoFocus
                value={form.name}
                onChange={(e) =>
                  setForm((v) => (v ? { ...v, name: e.target.value } : null))
                }
              />
            </label>
          )}
          {(form?.kind === "move" ||
            (form?.kind === "folder" && form.action !== "rename")) && (
            <label>
              目标文件夹
              <select
                value={form.parent_id || ""}
                onChange={(e) =>
                  setForm((v) =>
                    v ? { ...v, parent_id: e.target.value || null } : null,
                  )
                }
              >
                <option value="">根目录 / 未分类</option>
                {folders
                  .filter(
                    (f) =>
                      !f.deleted_at &&
                      (form.action !== "move" || f.id !== form.folder?.id),
                  )
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {form?.kind === "tags" && (
            <>
              <label>
                操作
                <select
                  value={form.tag_mode}
                  onChange={(e) =>
                    setForm((v) =>
                      v ? { ...v, tag_mode: e.target.value } : null,
                    )
                  }
                >
                  <option value="add">添加标签</option>
                  <option value="set">替换全部标签</option>
                  <option value="remove">移除标签</option>
                </select>
              </label>
              <div className="tag-checks">
                {tags.map((t) => (
                  <label className="checkbox-label" key={t.id}>
                    <input
                      type="checkbox"
                      checked={form.tag_ids?.includes(t.id) || false}
                      onChange={(e) =>
                        setForm((v) =>
                          v
                            ? {
                                ...v,
                                tag_ids: e.target.checked
                                  ? [...(v.tag_ids || []), t.id]
                                  : (v.tag_ids || []).filter(
                                      (id) => id !== t.id,
                                    ),
                              }
                            : null,
                        )
                      }
                    />
                    <span className="tag-dot" style={{ background: t.color }} />
                    {t.name}
                  </label>
                ))}
                {!tags.length && (
                  <p className="muted">先在左侧创建一个标签。</p>
                )}
              </div>
            </>
          )}
          <div className="dialog-actions">
            <Button type="button" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button
              variant={form?.kind === "delete" ? "danger" : "default"}
              disabled={action.isPending}
            >
              {action.isPending
                ? "保存中…"
                : form?.kind === "delete"
                  ? "确认移到回收站"
                  : "保存"}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!duplicateFiles.length}
        onOpenChange={(v) => !v && setDuplicateFiles([])}
        title="检测到相同内容"
        description={`${duplicateFiles.length} 个文件已经存在。可以保留现有文档，或明确创建副本。`}
      >
        <div className="dialog-actions">
          <Button onClick={() => setDuplicateFiles([])}>跳过重复文件</Button>
          <Button
            variant="default"
            onClick={() => {
              upload.mutate({ files: duplicateFiles, policy: "copy" });
              setDuplicateFiles([]);
            }}
          >
            保留副本
          </Button>
        </div>
      </Dialog>
      {context && (
        <div
          className="context-backdrop"
          onClick={() => setContext(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContext(null);
          }}
        >
          <div
            className="context-menu"
            role="menu"
            style={{ left: context.x, top: context.y }}
          >
            <button role="menuitem" onClick={() => onOpen(context.doc, true)}>
              <FolderOpen size={14} />
              打开阅读器
            </button>
            <button
              role="menuitem"
              onClick={() =>
                setForm({
                  kind: "rename",
                  name: context.doc.display_name,
                  document: context.doc,
                })
              }
            >
              重命名
            </button>
            <button
              role="menuitem"
              onClick={() =>
                setForm({
                  kind: "move",
                  name: "",
                  ids: [context.doc.id],
                  parent_id: context.doc.folder_id,
                })
              }
            >
              移动到…
            </button>
            <button
              role="menuitem"
              onClick={() =>
                setForm({
                  kind: "tags",
                  name: "",
                  ids: [context.doc.id],
                  tag_ids: context.doc.tag_ids || [],
                  tag_mode: "set",
                })
              }
            >
              设置标签
            </button>
            <a
              role="menuitem"
              href={`/api/documents/${context.doc.id}/download`}
            >
              <Download size={14} />
              下载原文件
            </a>
            {trash ? (
              <button
                role="menuitem"
                onClick={() =>
                  action.mutate({
                    path: `/documents/${context.doc.id}/restore`,
                  })
                }
              >
                恢复
              </button>
            ) : (
              <button
                role="menuitem"
                className="danger"
                onClick={() =>
                  setForm({
                    kind: "delete",
                    name: context.doc.display_name,
                    ids: [context.doc.id],
                  })
                }
              >
                <Trash2 size={14} />
                移到回收站
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
function formatSize(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 ** 2).toFixed(1)} MB`;
}
