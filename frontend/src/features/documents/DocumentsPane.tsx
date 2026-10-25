import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  FolderPlus,
  Search,
  Upload,
  X,
  Check,
  FileText,
  FolderOpen,
  ListFilter,
  MoreHorizontal,
  Plus,
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
import { ContextMenu, Menu, MenuItem } from "../../components/ui/menu";
import { Checkbox } from "../../components/ui/checkbox";
import { Select } from "../../components/ui/select";
import { Empty, ErrorState, Loading } from "../../components/common";
import { isActiveJob, jobNeedsAttention, jobProgress } from "../../lib/jobs";
import { FolderTree } from "./FolderTree";
import type { FolderAction } from "./FolderTree";
import { TagManager } from "./TagManager";
import { folderPathLabel } from "./folderNavigation";
import { FolderPicker } from "./FolderPicker";
import {
  KnowledgeBaseEditor,
  KnowledgeBaseIcon,
} from "../kb/KnowledgeBaseEditor";
import { collectDroppedFiles, uploadDocuments } from "./uploadDocuments";
import { useDocumentFormats } from "../../lib/documentFormats";
import type { UploadItem } from "./uploadDocuments";
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
type UploadRequest = {
  files: File[] | Promise<File[]>;
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
}: {
  kb: KnowledgeBase;
  folders: Folder[];
  tags: Tag[];
  trash: boolean;
  active?: boolean;
  layout?: "compact" | "page";
  onOpen: (doc: Document, reader?: boolean) => void;
  selectedId: string;
}) {
  const qc = useQueryClient();
  const formatCatalog = useDocumentFormats(active);
  const input = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const [editKnowledgeBase, setEditKnowledgeBase] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [navigation, setNavigation] = useState({ entries: ["root"], index: 0 });
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearchTerm(searchText.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [searchText]);
  const activeRef = useRef(active);
  const uploadInFlight = useRef(false);
  const uploadGeneration = useRef(0);
  const currentKbId = useRef(kb.id);
  currentKbId.current = kb.id;
  const [folderId, setFolderId] = useState(trash ? "" : "root");
  const [sort, setSort] = useState("updated");
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
  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      uploadGeneration.current += 1;
      setEditKnowledgeBase(false);
      setManageTags(false);
      setForm(null);
      setDuplicateFiles([]);
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
      searchOpen,
      searchTerm,
    ],
    queryFn: () =>
      api<{ items: Document[]; total: number; page_size: number }>(
        `/knowledge-bases/${kb.id}/documents${query({ folder_id: searchOpen ? undefined : folderId || undefined, include_descendants: trash, tag_ids: searchOpen ? tagId : "", trash, sort, ext: searchOpen ? ext : "", status: searchOpen ? status : "", q: searchOpen ? searchTerm : "", page, page_size: 50 })}`,
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
  const childFolders = folders.filter(
    (folder) =>
      !folder.deleted_at &&
      folder.parent_id === (folderId === "root" ? null : folderId),
  );
  function navigateFolder(id: string, record = true) {
    setFolderId(id);
    setSearchOpen(false);
    setSearchText("");
    setSearchTerm("");
    setPage(1);
    setSelected(new Set());
    if (record)
      setNavigation((value) => ({
        entries: [...value.entries.slice(0, value.index + 1), id],
        index: value.index + 1,
      }));
  }
  function navigateHistory(offset: number) {
    const index = navigation.index + offset;
    const id = navigation.entries[index];
    if (id === undefined) return;
    setNavigation((value) => ({ ...value, index }));
    navigateFolder(id, false);
  }
  const foldersById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const breadcrumbs: Folder[] = [];
  const seenAncestors = new Set<string>();
  let ancestor = activeFolder;
  while (ancestor && !seenAncestors.has(ancestor.id)) {
    seenAncestors.add(ancestor.id);
    breadcrumbs.unshift(ancestor);
    ancestor = ancestor.parent_id
      ? foldersById.get(ancestor.parent_id)
      : undefined;
  }
  useEffect(() => {
    setFolderId(trash ? "" : "root");
    setNavigation({ entries: ["root"], index: 0 });
    setSearchOpen(false);
    setSearchText("");
    setSearchTerm("");
    setPage(1);
    setSelected(new Set());
    setForm(null);
    setEditKnowledgeBase(false);
    uploadGeneration.current += 1;
  }, [kb.id, trash]);
  useEffect(() => {
    if (!active || documents.isFetching) return;
    if (
      documents.error instanceof ApiError &&
      documents.error.code === "invalid_folder" &&
      folderId &&
      folderId !== "root"
    ) {
      navigateFolder("root");
      setPage(1);
      setSelected(new Set());
      setForm(null);
      void qc.invalidateQueries({ queryKey: ["folders", kb.id] });
      toast.info("原文件夹已不可用，已返回知识库根目录");
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
    const refreshed = qc.invalidateQueries();
    setSelected(new Set());
    return refreshed;
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
    onSuccess: async (_, submitted) => {
      // Reconcile rows before closing: returning focus to a row that a later
      // refetch removes would immediately drop it back onto the document body.
      await refresh();
      setForm((current) =>
        current === submitted.formToClose ? null : current,
      );
      toast.success("操作已保存");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const upload = useMutation({
    mutationFn: async ({
      files: pendingFiles,
      policy = "skip",
      targetFolderId = folderId && folderId !== "root" ? folderId : null,
    }: UploadRequest) => {
      const generation = uploadGeneration.current;
      const submittedKbId = kb.id;
      const files = await pendingFiles;
      if (!files.length)
        throw new Error("没有读取到文件；空文件夹不会上传，请重新选择资料。");
      return {
        result: await uploadDocuments({
          kbId: submittedKbId,
          files,
          policy,
          targetFolderId,
          limits: formatCatalog.limits,
          onProgress: (items) => {
            if (currentKbId.current === submittedKbId) setUploadItems(items);
          },
        }),
        files,
        targetFolderId,
        generation,
        submittedKbId,
      };
    },
    onSuccess: ({
      result,
      files,
      targetFolderId,
      generation,
      submittedKbId,
    }) => {
      if (currentKbId.current === submittedKbId) setUploadItems(result.items);
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
      const failures = result.items.filter(
        (item) => item.status === "error",
      ).length;
      if (failures)
        toast.warning(`${failures} 个文件上传失败，可在上传结果中查看原因`);
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
    } else if (
      e.dataTransfer.files.length ||
      Array.from(e.dataTransfer.items || []).some(
        (item) => item.kind === "file",
      )
    ) {
      if (uploadInFlight.current) {
        toast.info("上一批文件仍在上传，请稍后再添加");
        return;
      }
      // Capture entry handles while the drop event still has access to them.
      startUpload({
        files: collectDroppedFiles(e.dataTransfer),
        targetFolderId: target,
      });
    }
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
      <div className="document-heading-bar explorer-heading">
        <header className="pane-header">
          {trash ? (
            <span className="document-library-icon">
              <Trash2 size={30} />
            </span>
          ) : (
            <KnowledgeBaseIcon kb={kb} size="large" />
          )}
          <div className="document-library-heading">
            <h2>{trash ? "回收站" : kb.name}</h2>
            <p className="document-library-description">
              {trash ? kb.name : kb.description || "个人知识库"}
            </p>
          </div>
          <Menu
            trigger={
              <Button size="icon" variant="ghost" aria-label="知识库操作">
                <MoreHorizontal size={18} />
              </Button>
            }
          >
            {!trash && (
              <MenuItem onSelect={() => setEditKnowledgeBase(true)}>
                编辑知识库
              </MenuItem>
            )}
            <MenuItem onSelect={() => void documents.refetch()}>
              刷新文件
            </MenuItem>
            {!trash && (
              <MenuItem onSelect={() => setManageTags(true)}>管理标签</MenuItem>
            )}
          </Menu>
        </header>
        {!trash && (
          <>
            <input
              ref={input}
              hidden
              type="file"
              aria-label="上传文档"
              accept={formatCatalog.accept}
              multiple
              onChange={(event) => {
                if (event.target.files?.length)
                  startUpload({ files: Array.from(event.target.files) });
                event.target.value = "";
              }}
            />
            <input
              ref={directoryInput}
              hidden
              type="file"
              aria-label="上传本地文件夹"
              multiple
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(event) => {
                if (event.target.files?.length)
                  startUpload({ files: Array.from(event.target.files) });
                event.target.value = "";
              }}
            />
          </>
        )}
      </div>
      {!trash && formatCatalog.unavailable.length > 0 && (
        <details className="notice warning tiny" aria-label="文件格式可用性">
          <summary>
            部分格式暂不可用：
            {formatCatalog.unavailable
              .map((format) => format.extension.toUpperCase())
              .join("、")}
          </summary>
          {formatCatalog.unavailable.map((format) => (
            <p key={format.extension}>
              {format.extension.toUpperCase()} ·{" "}
              {format.reason || "当前服务暂不提供此格式解析"}
            </p>
          ))}
        </details>
      )}
      <div className="document-browser-body">
        {trash && (
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
                active={active}
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
        )}
        <div className="document-files-panel">
          <div className="document-list-heading explorer-toolbar">
            <span>
              {searchOpen ? "搜索资料" : "内容"}
              <small>
                {total + (!searchOpen && !trash ? childFolders.length : 0)} 项
              </small>
            </span>
            <div className="row gap">
              {!trash && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="搜索知识库资料"
                  title="搜索资料"
                  onClick={() => {
                    setSearchOpen(true);
                    setPage(1);
                    setSelected(new Set());
                  }}
                >
                  <Search size={16} />
                </Button>
              )}
              <Menu
                trigger={
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="排序文件"
                    title="排序"
                  >
                    <ArrowDownAZ size={16} />
                  </Button>
                }
              >
                {[
                  ["updated", "更新时间"],
                  ["created", "创建时间"],
                  ["size", "大小"],
                  ["type", "类型"],
                  ["name", "名称"],
                ].map(([key, label]) => (
                  <MenuItem
                    key={key}
                    onSelect={() => {
                      setSort(key);
                      setPage(1);
                      setSelected(new Set());
                    }}
                  >
                    <span>{label}</span>
                    {sort === key && <Check size={14} />}
                  </MenuItem>
                ))}
              </Menu>
              {!trash && (
                <Menu
                  trigger={
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="添加文件"
                      title="添加文件"
                      disabled={upload.isPending}
                    >
                      <Plus size={18} />
                    </Button>
                  }
                >
                  <MenuItem onSelect={() => input.current?.click()}>
                    <Upload size={16} />
                    本地文件
                  </MenuItem>
                  <MenuItem onSelect={() => directoryInput.current?.click()}>
                    <FolderOpen size={16} />
                    本地文件夹
                  </MenuItem>
                  <MenuItem
                    onSelect={() => openFolderForm("create", activeFolder)}
                  >
                    <FolderPlus size={16} />
                    新建文件夹
                  </MenuItem>
                </Menu>
              )}
            </div>
          </div>
          {!trash && (
            <div className="explorer-navigation">
              <Button
                size="icon"
                variant="ghost"
                aria-label={searchOpen ? "退出搜索" : "后退"}
                disabled={!searchOpen && navigation.index === 0}
                onClick={() =>
                  searchOpen
                    ? (setSearchOpen(false), setPage(1), setSelected(new Set()))
                    : navigateHistory(-1)
                }
              >
                <ArrowLeft size={15} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="前进"
                disabled={
                  searchOpen ||
                  navigation.index >= navigation.entries.length - 1
                }
                onClick={() => navigateHistory(1)}
              >
                <ArrowRight size={15} />
              </Button>
              {searchOpen ? (
                <div className="explorer-search-input">
                  <Search size={15} />
                  <input
                    autoFocus
                    aria-label="在知识库中搜索"
                    placeholder="在知识库中搜索"
                    value={searchText}
                    onChange={(event) => {
                      setSearchText(event.target.value);
                      setPage(1);
                      setSelected(new Set());
                    }}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="清除搜索"
                    onClick={() => {
                      setSearchText("");
                      setSearchTerm("");
                    }}
                  >
                    <X size={13} />
                  </Button>
                </div>
              ) : (
                <nav className="explorer-breadcrumbs" aria-label="文件夹路径">
                  <button
                    onClick={() => navigateFolder("root")}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.stopPropagation();
                      drop(event, null);
                    }}
                    aria-label="知识库根目录"
                    aria-current={folderId === "root" ? "location" : undefined}
                  >
                    知识库根目录
                  </button>
                  {breadcrumbs.map((folder) => (
                    <span key={folder.id}>
                      <ChevronRight size={12} />
                      <button
                        aria-current={
                          folder.id === folderId ? "location" : undefined
                        }
                        onClick={() => navigateFolder(folder.id)}
                      >
                        {folder.name}
                      </button>
                    </span>
                  ))}
                </nav>
              )}
            </div>
          )}
          {searchOpen && (
            <div className="file-filters explorer-search-filters">
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
                  ...formatCatalog.formats.map((format) => ({
                    value: format.extension,
                    label: format.extension.toUpperCase(),
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setManageTags(true)}
              >
                管理标签
              </Button>
            </div>
          )}
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
          </div>
          <div className="document-list">
            {!trash && !searchOpen && (
              <FolderTree
                mode="explorer"
                parentId={folderId === "root" ? null : folderId}
                sort={sort}
                active={active}
                folders={folders}
                selected={folderId}
                onSelect={navigateFolder}
                onAction={openFolderForm}
                onDrop={drop}
              />
            )}
            {documents.isPending ? (
              <Loading />
            ) : documents.isError ? (
              <ErrorState
                error={documents.error}
                retry={() => void documents.refetch()}
              />
            ) : !rows.length &&
              (searchOpen || trash || !childFolders.length) ? (
              <Empty
                title={
                  trash
                    ? "回收站很干净"
                    : searchOpen
                      ? "暂无匹配内容"
                      : "这个文件夹还是空的"
                }
              >
                <p>
                  {trash
                    ? "删除的文档可以在这里恢复。"
                    : searchOpen
                      ? "换个关键词，或调整上方的筛选条件。"
                      : "添加文件或文件夹，开始整理你的知识。"}
                </p>
                {!trash && !searchOpen && (
                  <Button size="sm" onClick={() => input.current?.click()}>
                    <UploadCloud size={14} />
                    上传文件
                  </Button>
                )}
              </Empty>
            ) : (
              rows.map((doc) => (
                <ContextMenu
                  key={doc.id}
                  active={active}
                  trigger={
                    <div
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
                            {new Date(doc.created_at).toLocaleDateString(
                              "zh-CN",
                            )}{" "}
                            · {formatSize(doc.size_bytes)}
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
                  }
                >
                  {docMenu(doc)}
                </ContextMenu>
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
                    {r.document?.display_name || r.filename || `文件 ${i + 1}`}{" "}
                    ·{" "}
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
      <KnowledgeBaseEditor
        open={editKnowledgeBase}
        onOpenChange={setEditKnowledgeBase}
        knowledgeBase={kb}
      />
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
            : "知识库根目录"}
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
