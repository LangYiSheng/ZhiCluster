import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link } from "react-router-dom";
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
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, errorText, json, query } from "../../lib/api";
import type {
  Document,
  Folder,
  Job,
  JobPage,
  KnowledgeBase,
  Tag,
} from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Menu, MenuItem } from "../../components/ui/menu";
import { Checkbox } from "../../components/ui/checkbox";
import { Select } from "../../components/ui/select";
import { Empty, ErrorState, Loading } from "../../components/common";
import { isActiveJob, jobNeedsAttention, jobProgress } from "../../lib/jobs";
import { FolderTree } from "./FolderTree";
import type { FolderAction } from "./FolderTree";
import { TagManager } from "./TagManager";
import { folderPathLabel } from "./folderNavigation";
import { FolderPicker } from "./FolderPicker";
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
type UploadRequest = {
  files: File[];
  policy?: string;
  targetFolderId?: string | null;
};
export function DocumentsPane({
  kb,
  folders,
  tags,
  trash,
  active = true,
  layout = "compact",
  onOpen,
  selectedId,
  onUnclassified,
}: {
  kb: KnowledgeBase;
  folders: Folder[];
  tags: Tag[];
  trash: boolean;
  active?: boolean;
  layout?: "compact" | "page";
  onOpen: (doc: Document, reader?: boolean) => void;
  selectedId: string;
  onUnclassified?: () => void;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const activeRef = useRef(active);
  const uploadInFlight = useRef(false);
  const uploadGeneration = useRef(0);
  const [folderId, setFolderId] = useState("");
  const [sort, setSort] = useState("date");
  const [ext, setExt] = useState("");
  const [status, setStatus] = useState("");
  const [tagFilter, setTagFilter] = useState({ kbId: kb.id, id: "" });
  const tagId =
    tagFilter.kbId === kb.id && tags.some((tag) => tag.id === tagFilter.id)
      ? tagFilter.id
      : "";
  const [manageTags, setManageTags] = useState(false);
  const [page, setPage] = useState(1);
  const [selection, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<FormState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [duplicateFiles, setDuplicateFiles] = useState<File[]>([]);
  const [duplicateTarget, setDuplicateTarget] = useState<string | null>(null);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [context, setContext] = useState<{
    x: number;
    y: number;
    doc: Document;
  } | null>(null);
  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      uploadGeneration.current += 1;
      setManageTags(false);
      setForm(null);
      setDuplicateFiles([]);
      setContext(null);
      setDragging(false);
    }
  }, [active]);
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
    enabled: active,
    refetchInterval: (q) =>
      q.state.data?.items.some((d) =>
        ["queued", "parsing", "chunking"].includes(d.parse_status),
      )
        ? 2000
        : 5000,
  });
  const rows = documents.data?.items || [];
  const jobDocumentIds = rows.map((row) => row.id).join(",");
  const jobs = useQuery({
    queryKey: ["document-jobs", kb.id, jobDocumentIds],
    queryFn: () =>
      api<Job[]>(
        `/ingestion/jobs${query({ kb_id: kb.id, document_ids: jobDocumentIds, view: "current" })}`,
      ),
    refetchInterval: 4000,
    enabled: active && !!jobDocumentIds,
  });
  const jobSummary = useQuery({
    queryKey: ["job-counts", kb.id],
    queryFn: () =>
      api<JobPage>(
        `/ingestion/jobs/page${query({ kb_id: kb.id, page_size: 1 })}`,
      ),
    refetchInterval: 4000,
    enabled: active,
  });
  const deletedKbs = useQuery({
    queryKey: ["deleted-kbs"],
    queryFn: () =>
      api<KnowledgeBase[]>("/knowledge-bases?include_deleted=true"),
    enabled: active && trash,
  });
  const selected = new Set(
    rows.filter((row) => selection.has(row.id)).map((row) => row.id),
  );
  const activeFolder = folders.find((f) => f.id === folderId);
  const total = documents.data?.total || 0;
  useEffect(() => {
    if (!active || documents.isFetching) return;
    if (
      documents.error instanceof ApiError &&
      documents.error.code === "invalid_folder" &&
      folderId &&
      folderId !== "root"
    ) {
      setFolderId("");
      setPage(1);
      setSelected(new Set());
      setForm(null);
      void qc.invalidateQueries({ queryKey: ["folders", kb.id] });
      toast.info("原文件夹已不可用，已返回全部文档");
    }
  }, [active, documents.error, documents.isFetching, folderId, kb.id, qc]);
  useEffect(() => {
    if (!documents.data || documents.isFetching || documents.isError) return;
    const visible = new Set(documents.data.items.map((row) => row.id));
    setSelected((current) =>
      [...current].every((id) => visible.has(id))
        ? current
        : new Set([...current].filter((id) => visible.has(id))),
    );
    setForm((current) =>
      current?.ids?.some((id) => !visible.has(id)) ? null : current,
    );
  }, [documents.data, documents.isFetching, documents.isError]);
  useEffect(() => {
    if (!active || !documents.data || documents.isFetching || documents.isError)
      return;
    const lastPage = Math.max(
      1,
      Math.ceil(documents.data.total / documents.data.page_size),
    );
    if (page > lastPage) {
      setPage(lastPage);
      setSelected(new Set());
    }
  }, [active, documents.data, documents.isFetching, documents.isError, page]);
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
      formToClose?: FormState;
    }) => api(path, json(method, body)),
    onSuccess: (_, submitted) => {
      refresh();
      setForm((current) =>
        current === submitted.formToClose ? null : current,
      );
      toast.success("操作已保存");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const upload = useMutation({
    mutationFn: async ({
      files,
      policy = "skip",
      targetFolderId = folderId && folderId !== "root" ? folderId : null,
    }: UploadRequest) => {
      const generation = uploadGeneration.current;
      const data = new FormData();
      files.forEach((f) => data.append("files", f));
      if (targetFolderId) data.append("folder_id", targetFolderId);
      data.append("duplicate_policy", policy);
      return {
        result: await api<{ items: UploadItem[] }>(
          `/knowledge-bases/${kb.id}/uploads`,
          { method: "POST", body: data },
        ),
        files,
        targetFolderId,
        generation,
      };
    },
    onSuccess: ({ result, files, targetFolderId, generation }) => {
      setUploadItems(result.items);
      const duplicates = result.items
        .flatMap((r, i) => (r.status === "duplicate" ? [files[i]] : []))
        .filter((f): f is File => !!f);
      if (
        duplicates.length &&
        activeRef.current &&
        generation === uploadGeneration.current
      ) {
        setDuplicateFiles(duplicates);
        setDuplicateTarget(targetFolderId);
      }
      const count = result.items.filter((r) => r.status === "queued").length;
      if (count) toast.success(`${count} 个文件已上传，后台正在处理`);
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
    onSettled: () => {
      uploadInFlight.current = false;
    },
  });
  function startUpload(request: UploadRequest) {
    if (uploadInFlight.current) {
      toast.info("上一批文件仍在上传，请稍后再添加");
      return;
    }
    uploadInFlight.current = true;
    upload.mutate(request);
  }
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
    if (trash) return;
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
      if (!f || f.kb_id !== kb.id || f.deleted_at) {
        toast.error("只能移动当前知识库中的有效文件夹");
        return;
      }
      action.mutate({
        path: `/folders/${sourceFolder}`,
        method: "PATCH",
        body: { parent_id: target, version: f.version },
      });
    } else if (e.dataTransfer.files.length)
      startUpload({
        files: Array.from(e.dataTransfer.files),
        targetFolderId: target,
      });
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
        formToClose: form,
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
        formToClose: form,
        body: { display_name: form.name, version: form.document?.version },
      });
    } else if (form.kind === "delete" && form.folder) {
      action.mutate({
        path: `/folders/${form.folder.id}`,
        method: "DELETE",
        formToClose: form,
      });
    } else {
      action.mutate({
        path: "/documents/batch",
        formToClose: form,
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
            <MenuItem onSelect={() => onOpen(doc, false)}>查看属性</MenuItem>
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
  if (!active) return null;
  return (
    <section
      className={`documents-pane documents-${layout} documents-pane-${layout} ${trash ? "documents-trash" : ""} ${dragging ? "dragging" : ""}`}
      aria-label={trash ? "回收站内容" : `${kb.name}文档管理`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!trash && e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => drop(e, folderId && folderId !== "root" ? folderId : null)}
    >
      <div className="document-heading-bar">
        <header className="pane-header">
          {layout === "page" && (
            <span className="document-library-icon" aria-hidden="true">
              {trash ? <Trash2 size={27} /> : <FolderOpen size={29} />}
            </span>
          )}
          <div className="document-library-heading">
            <span className="eyebrow">{trash ? kb.name : "我的知识库"}</span>
            <h2>{trash ? "回收站" : kb.name}</h2>
            {layout === "page" && !trash && kb.description && (
              <p className="document-library-description">{kb.description}</p>
            )}
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
                  startUpload({ files: Array.from(e.target.files) });
                e.target.value = "";
              }}
            />
            <p className="tiny muted">PDF、DOCX、Markdown、TXT · 可拖拽上传</p>
          </div>
        )}
      </div>
      <div className="document-browser-body">
        <aside
          className="document-folder-panel"
          aria-label={trash ? "已删除文件夹" : "文档文件夹"}
        >
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
                  setSelected(new Set());
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
                已删除知识库 ·{" "}
                {deletedKbs.data.filter((k) => k.deleted_at).length}
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
        </aside>
        <div className="document-files-panel">
          <div className="document-list-heading">
            <span>
              {activeFolder?.name ||
                (folderId === "root" ? "未分类" : "全部文档")}
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
                <MenuItem
                  key={key}
                  onSelect={() => {
                    setSort(key);
                    setPage(1);
                    setSelected(new Set());
                  }}
                >
                  {sort === key && <Check size={13} />} {label}
                </MenuItem>
              ))}
            </Menu>
          </div>
          <div className="file-filters">
            <ListFilter size={13} />
            <Select
              aria-label="文件类型筛选"
              value={ext}
              size="sm"
              onValueChange={(value) => {
                setExt(value);
                setPage(1);
                setSelected(new Set());
              }}
              options={[
                { value: "", label: "全部类型" },
                ...["pdf", "docx", "md", "txt"].map((value) => ({
                  value,
                  label: value.toUpperCase(),
                })),
              ]}
            />
            <Select
              aria-label="处理状态筛选"
              value={status}
              size="sm"
              onValueChange={(value) => {
                setStatus(value);
                setPage(1);
                setSelected(new Set());
              }}
              options={[
                { value: "", label: "全部状态" },
                { value: "ready", label: "已处理" },
                { value: "queued", label: "未处理" },
                { value: "failed", label: "处理失败" },
              ]}
            />
            <Select
              aria-label="标签筛选"
              value={tagId}
              size="sm"
              onValueChange={(value) => {
                setTagFilter({ kbId: kb.id, id: value });
                setPage(1);
                setSelected(new Set());
              }}
              options={[
                { value: "", label: "全部标签" },
                ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
              ]}
            />
            {!trash && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setManageTags(true)}
              >
                管理标签
              </Button>
            )}
          </div>
          <div className="selection-bar">
            <label className="checkbox-label">
              <Checkbox
                aria-label="全选当前页"
                checked={!!rows.length && rows.every((d) => selected.has(d.id))}
                indeterminate={
                  rows.some((d) => selected.has(d.id)) &&
                  !rows.every((d) => selected.has(d.id))
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? new Set(rows.map((d) => d.id))
                      : new Set(),
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
                        setForm({
                          kind: "delete",
                          name: "",
                          ids: [...selected],
                        })
                      }
                    >
                      删除所选
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
            {layout === "page" && !selected.size && (
              <span className="document-columns" aria-hidden="true">
                <span>添加日期 · 大小</span>
                <span>处理状态</span>
              </span>
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
                  <Checkbox
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
                    onClick={() => onOpen(doc, true)}
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
                      <DocumentProcessing
                        document={doc}
                        jobs={jobs.data || []}
                      />
                      {!!doc.tag_ids?.length && (
                        <span className="document-tags">
                          {tags
                            .filter((tag) => doc.tag_ids?.includes(tag.id))
                            .map((tag) => (
                              <span key={tag.id} className="document-tag">
                                <span
                                  className="tag-dot"
                                  style={{ background: tag.color }}
                                />
                                {tag.name}
                              </span>
                            ))}
                        </span>
                      )}
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
                onClick={() => {
                  setPage((p) => p - 1);
                  setSelected(new Set());
                }}
              >
                上一页
              </Button>
              <small>
                {page} / {Math.ceil(total / 50)}
              </small>
              <Button
                size="sm"
                disabled={page * 50 >= total}
                onClick={() => {
                  setPage((p) => p + 1);
                  setSelected(new Set());
                }}
              >
                下一页
              </Button>
            </div>
          )}
          <div className="document-footer">
            <small>{total} 个文档</small>
            <Link to={`/tasks?kb=${kb.id}`} className="document-tasks-link">
              任务列表
              {!!jobSummary.data?.counts?.active &&
                ` · ${jobSummary.data.counts.active} 项进行中`}
              {!!jobSummary.data?.counts?.attention &&
                ` · ${jobSummary.data.counts.attention} 项待处理`}
            </Link>
          </div>
          {dragging && (
            <div className="drop-overlay">
              <UploadCloud size={40} />
              <strong>放下文件，添加到知识库</strong>
            </div>
          )}
          {!!uploadItems.length && (
            <details
              className="upload-results"
              open={
                uploadItems.some((item) => item.status === "error") || undefined
              }
            >
              <summary>
                上传结果 · {uploadItems.length} 个文件
                {uploadItems.some((item) => item.status === "error") && (
                  <span className="danger">含上传失败</span>
                )}
              </summary>
              <div className="upload-results-content">
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
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="关闭上传结果"
                  onClick={() => setUploadItems([])}
                >
                  清除记录
                </Button>
              </div>
            </details>
          )}
        </div>
      </div>
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
            <FolderPicker
              folders={folders}
              excludedRoot={
                form.kind === "folder" && form.action === "move"
                  ? form.folder?.id
                  : undefined
              }
              value={form.parent_id || ""}
              onValueChange={(value) =>
                setForm((v) => (v ? { ...v, parent_id: value || null } : null))
              }
            />
          )}
          {form?.kind === "tags" && (
            <>
              <label>
                操作
                <Select
                  aria-label="标签操作"
                  value={form.tag_mode || "add"}
                  onValueChange={(value) =>
                    setForm((v) => (v ? { ...v, tag_mode: value } : null))
                  }
                  options={[
                    { value: "add", label: "添加标签" },
                    { value: "set", label: "替换全部标签" },
                    { value: "remove", label: "移除标签" },
                  ]}
                />
              </label>
              <div className="tag-checks">
                {tags.map((t) => (
                  <label className="checkbox-label" key={t.id}>
                    <Checkbox
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
                  <p className="muted">还没有标签，可在文件筛选旁管理标签。</p>
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
      <TagManager
        key={kb.id}
        kbId={kb.id}
        tags={tags}
        open={manageTags}
        onOpenChange={setManageTags}
        onDelete={(id) => {
          if (tagId === id) {
            setTagFilter({ kbId: kb.id, id: "" });
            setPage(1);
          }
        }}
      />
      <Dialog
        open={!!duplicateFiles.length}
        onOpenChange={(v) => !v && setDuplicateFiles([])}
        title="检测到相同内容"
        description={`${duplicateFiles.length} 个文件已经存在。可以保留现有文档，或明确创建副本。`}
      >
        <p className="tiny muted">
          保存位置：
          {duplicateTarget
            ? folderPathLabel(folders, duplicateTarget) || "原上传文件夹"
            : "根目录 / 未分类"}
        </p>
        <ul>
          {duplicateFiles.map((file, index) => (
            <li key={`${file.name}-${index}`}>{file.name}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <Button onClick={() => setDuplicateFiles([])}>跳过重复文件</Button>
          <Button
            variant="default"
            onClick={() => {
              startUpload({
                files: duplicateFiles,
                policy: "copy",
                targetFolderId: duplicateTarget,
              });
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
            {!trash && (
              <>
                <button
                  role="menuitem"
                  onClick={() => onOpen(context.doc, true)}
                >
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
              </>
            )}
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
function DocumentProcessing({
  document,
  jobs,
}: {
  document: Document;
  jobs: Job[];
}) {
  const related = jobs.filter((job) => job.document_id === document.id);
  const running = related.find(isActiveJob);
  if (running) {
    if (
      document.parse_status === "ready" &&
      document.index_status === "ready"
    ) {
      const metadataLabel =
        running.status === "queued"
          ? "后台任务排队中"
          : running.status === "retry_wait"
            ? "后台任务待重试"
            : running.stage === "classifying"
              ? "分类建议生成中"
              : running.stage === "summarizing"
                ? "摘要生成中"
                : running.stage === "embedding" || running.kind === "reindex"
                  ? "索引更新中"
                  : running.stage === "enriching"
                    ? "摘要与建议生成中"
                    : "后台完善中";
      return (
        <span className="status status-processing">
          可检索 · {metadataLabel}
        </span>
      );
    }
    const pending = running.status === "queued";
    return (
      <span className="status status-processing">
        {pending
          ? "未处理"
          : running.status === "retry_wait"
            ? "等待重试"
            : `正在处理 ${jobProgress(running)}%`}
      </span>
    );
  }
  if (document.parse_status === "failed")
    return <span className="status status-failed">处理失败</span>;
  if (document.parse_status !== "ready")
    return <span className="status status-queued">未处理</span>;
  if (related[0] && jobNeedsAttention(related[0]))
    return <span className="status status-partial_ready">任务待处理</span>;
  return null;
}
function formatSize(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 ** 2).toFixed(1)} MB`;
}
