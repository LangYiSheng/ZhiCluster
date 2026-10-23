import { lazy, Suspense, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  FileText,
  FolderOpen,
  History,
  Menu as MenuIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, errorText, json } from "../lib/api";
import type {
  Citation,
  Document,
  Folder,
  KnowledgeBase,
  Tag,
} from "../lib/api";
import { applyAppearance } from "../lib/appearance";
import { useUI } from "../stores/ui";
import { Library } from "../features/kb/Library";
import { DocumentsPane } from "../features/documents/DocumentsPane";
import { SearchDialog } from "../features/search/SearchDialog";
import { Button } from "../components/ui/button";
import { Empty, ErrorState, Loading } from "../components/common";
import { ReferencePane } from "./ReferencePane";
import { emptyReferences, referenceReducer } from "./referenceWorkspace";
import type { ReferenceAction } from "./referenceWorkspace";
const Reader = lazy(() =>
  import("../features/documents/Reader").then((m) => ({ default: m.Reader })),
);
const Chat = lazy(() =>
  import("../features/chat/Chat").then((m) => ({ default: m.Chat })),
);
const Settings = lazy(() =>
  import("../features/settings/Settings").then((m) => ({
    default: m.Settings,
  })),
);

function EmptyTrash() {
  const client = useQueryClient();
  const bases = useQuery({
    queryKey: ["deleted-kbs"],
    queryFn: () =>
      api<KnowledgeBase[]>("/knowledge-bases?include_deleted=true"),
  });
  const restore = useMutation({
    mutationFn: (id: string) =>
      api(`/knowledge-bases/${id}/restore`, json("POST")),
    onSuccess: () => {
      void client.invalidateQueries();
      toast.success("知识库已恢复");
    },
    onError: (error) => toast.error(errorText(error)),
  });
  if (bases.isPending) return <Loading />;
  if (bases.isError)
    return (
      <ErrorState error={bases.error} retry={() => void bases.refetch()} />
    );
  const deleted = bases.data.filter((base) => base.deleted_at);
  return (
    <section className="empty-trash-page">
      <h1>回收站</h1>
      {deleted.length ? (
        <div className="deleted-library-cards">
          {deleted.map((base) => (
            <div key={base.id}>
              <BookOpen size={20} />
              <span>{base.name}</span>
              <Button
                disabled={restore.isPending}
                onClick={() => restore.mutate(base.id)}
              >
                恢复知识库
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="回收站很干净">
          删除的文档、文件夹和知识库会显示在这里。
        </Empty>
      )}
    </section>
  );
}

export function App() {
  const ui = useUI();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [savedKb, setSavedKb] = useState(
    () => localStorage.getItem("zhicluster-kb") || "",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLButtonElement | null>(
    null,
  );
  const [mobileLibrary, setMobileLibrary] = useState(false);
  const [documentCitation, setDocumentCitation] = useState<
    Citation | undefined
  >();
  const [references, dispatchReference] = useReducer(
    referenceReducer,
    emptyReferences,
  );
  const citationRequest = useRef(0);
  const kbs = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: () => api<KnowledgeBase[]>("/knowledge-bases"),
  });
  const kbId = params.get("kb") || savedKb;
  const kb = kbs.data?.find((base) => base.id === kbId) || kbs.data?.[0];
  const actualKbId = kb?.id || "";
  const folders = useQuery({
    queryKey: ["folders", actualKbId],
    queryFn: () =>
      api<Folder[]>(
        `/knowledge-bases/${actualKbId}/folders?include_deleted=true`,
      ),
    enabled: !!actualKbId,
  });
  const tags = useQuery({
    queryKey: ["tags", actualKbId],
    queryFn: () => api<Tag[]>(`/knowledge-bases/${actualKbId}/tags`),
    enabled: !!actualKbId,
  });
  const selectedId = params.get("document") || "";
  const reader = params.get("mode") === "read";
  const view =
    location.pathname === "/settings"
      ? "settings"
      : location.pathname === "/trash"
        ? "trash"
        : location.pathname === "/document"
          ? "document"
          : "chat";
  const viewName =
    view === "settings"
      ? "设置"
      : view === "trash"
        ? "回收站"
        : view === "document"
          ? "文档管理"
          : "知识对话";
  const referencesOpen = references.tabs.length > 0;
  const filesWidth = Math.max(380, ui.filesWidth);
  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const appearance = {
      theme: ui.theme,
      palette: ui.palette,
      fontPairing: ui.fontPairing,
      readingScale: ui.readingScale,
    };
    const apply = () => applyAppearance(appearance, system.matches);
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [ui.theme, ui.palette, ui.fontPairing, ui.readingScale]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
      if (event.key === "Escape" && !event.defaultPrevented)
        setMobileLibrary(false);
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    citationRequest.current += 1;
    setSearchOpen(false);
    setHistoryOpen(false);
    setMobileLibrary(false);
  }, [location.key]);
  useEffect(() => {
    dispatchReference({ type: "clear" });
    setHistoryOpen(false);
    citationRequest.current += 1;
  }, [actualKbId]);

  function updateReferences(action: ReferenceAction) {
    if (action.type === "clear") citationRequest.current += 1;
    dispatchReference(action);
  }
  function chooseKb(id: string) {
    setSavedKb(id);
    localStorage.setItem("zhicluster-kb", id);
    setHistoryOpen(false);
    setMobileLibrary(false);
    setDocumentCitation(undefined);
    updateReferences({ type: "clear" });
    setParams({ kb: id });
  }
  function to(path: string) {
    citationRequest.current += 1;
    setMobileLibrary(false);
    setHistoryOpen(false);
    navigate(`/${path}${actualKbId ? `?kb=${actualKbId}` : ""}`);
  }
  function openLibrary() {
    if (!kb) return;
    setMobileLibrary(false);
    dispatchReference({
      type: "open",
      tab: {
        id: "library",
        kind: "library",
        title: "资料管理",
        kb,
        reader: false,
      },
    });
  }
  function referenceDocument(doc: Document, read = false, citation?: Citation) {
    const base = kbs.data?.find((item) => item.id === doc.kb_id);
    if (!base) {
      toast.error("知识库已不可访问，请刷新后重试");
      return;
    }
    dispatchReference({
      type: "open",
      tab: {
        id: `document-${doc.id}`,
        kind: "document",
        title: doc.display_name,
        kb: base,
        documentId: doc.id,
        reader: read,
        citation: citation ? { ...citation } : undefined,
      },
    });
  }
  function openDoc(doc: Document, read = false) {
    if (view === "chat") {
      referenceDocument(doc, read);
      return;
    }
    if (view === "trash") {
      toast.info("恢复文档后即可查看内容");
      return;
    }
    setDocumentCitation(undefined);
    navigate(
      `/document?kb=${doc.kb_id}&document=${doc.id}${read ? "&mode=read" : ""}`,
    );
  }
  function openCitation(citation: Citation) {
    const request = ++citationRequest.current;
    void api<Document>(`/documents/${citation.document_id}`)
      .then((doc) => {
        if (request !== citationRequest.current) return;
        if (view === "chat") {
          referenceDocument(doc, true, citation);
          return;
        }
        setDocumentCitation({ ...citation });
        navigate(`/document?kb=${doc.kb_id}&document=${doc.id}&mode=read`);
      })
      .catch((error) => {
        if (request === citationRequest.current) toast.error(errorText(error));
      });
  }
  function toggleLibrary() {
    if (window.innerWidth <= 1023) setMobileLibrary((value) => !value);
    else ui.toggleSidebar();
  }
  function resize(
    kind: "library" | "files",
    event: PointerEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    const start = event.clientX;
    const initial = kind === "library" ? ui.libraryWidth : filesWidth;
    function move(pointer: globalThis.PointerEvent) {
      const width =
        initial + (pointer.clientX - start) * (kind === "files" ? -1 : 1);
      ui.setWidths(
        kind === "library" ? width : ui.libraryWidth,
        kind === "files" ? width : filesWidth,
      );
    }
    function stop() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
  }
  const layoutStyle = {
    "--library-width": `${ui.sidebarOpen ? ui.libraryWidth : 0}px`,
    "--reference-width": `${filesWidth}px`,
  } as CSSProperties;
  if (location.pathname === "/agent")
    return <Navigate replace to={`/chat${kbId ? `?kb=${kbId}` : ""}`} />;
  return (
    <div
      className={`app-shell ${!ui.sidebarOpen ? "sidebar-collapsed" : ""} ${mobileLibrary ? "mobile-library-open" : ""} ${view === "settings" ? "settings-mode" : ""}`}
      style={layoutStyle}
    >
      <aside
        className="library-slot"
        aria-label="知识库与主导航"
        hidden={view === "settings"}
      >
        <div className="sidebar-brand">
          <img src="/favicon.svg" alt="" />
          <div>
            <strong>知簇</strong>
            <small>你的知识，自成一簇</small>
          </div>
          <Button
            className="sidebar-close"
            variant="ghost"
            size="icon"
            aria-label="关闭知识库栏"
            onClick={() => setMobileLibrary(false)}
          >
            <X size={17} />
          </Button>
        </div>
        <nav className="primary-navigation" aria-label="主导航">
          <button
            aria-current={view === "chat" ? "page" : undefined}
            onClick={() => to("chat")}
          >
            <MessageSquare size={18} />
            知识对话
          </button>
          <button
            aria-current={view === "document" ? "page" : undefined}
            onClick={() => to("document")}
          >
            <FileText size={18} />
            文档管理
          </button>
        </nav>
        <div className="library-scroll">
          {kbs.isPending ? (
            <Loading />
          ) : kbs.isError ? (
            <ErrorState error={kbs.error} retry={() => void kbs.refetch()} />
          ) : (
            <Library
              knowledgeBases={kbs.data || []}
              kbId={actualKbId}
              trash={view === "trash"}
              onSelect={chooseKb}
            />
          )}
        </div>
        <div className="sidebar-tools">
          <button
            aria-current={view === "trash" ? "page" : undefined}
            onClick={() => to("trash")}
          >
            <Trash2 size={17} />
            回收站
          </button>
          <button onClick={() => to("settings")}>
            <Settings2 size={17} />
            设置
          </button>
        </div>
      </aside>
      <div
        className="resize-handle library-resize"
        hidden={view === "settings"}
        role="separator"
        aria-label="调整知识库栏宽度"
        aria-orientation="vertical"
        aria-valuenow={ui.libraryWidth}
        aria-valuemin={200}
        aria-valuemax={360}
        tabIndex={0}
        onPointerDown={(event) => resize("library", event)}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            ui.setWidths(
              ui.libraryWidth + (event.key === "ArrowRight" ? 10 : -10),
              filesWidth,
            );
          }
        }}
      />
      <main className="workspace">
        <header className="workspace-header">
          <div className="row gap breadcrumb">
            {view === "settings" ? (
              <Button variant="ghost" size="sm" onClick={() => to("chat")}>
                <ArrowLeft size={16} />
                返回工作区
              </Button>
            ) : (
              <>
                <Button
                  className="desktop-sidebar-toggle"
                  variant="ghost"
                  size="icon"
                  aria-label={ui.sidebarOpen ? "折叠知识库栏" : "展开知识库栏"}
                  aria-expanded={ui.sidebarOpen}
                  onClick={toggleLibrary}
                >
                  {ui.sidebarOpen ? (
                    <PanelLeftClose size={18} />
                  ) : (
                    <PanelLeftOpen size={18} />
                  )}
                </Button>
                <Button
                  className="mobile-library-toggle"
                  variant="ghost"
                  size="icon"
                  aria-label="展开知识库栏"
                  aria-expanded={mobileLibrary}
                  onClick={toggleLibrary}
                >
                  <MenuIcon size={18} />
                </Button>
                {view === "chat" && (
                  <>
                    <BookOpen size={14} />
                    <span>{kb?.name || "知识工作空间"}</span>
                    <ChevronRight size={12} />
                  </>
                )}
              </>
            )}
            <strong>{viewName}</strong>
            {view === "document" && selectedId && (
              <Button variant="ghost" size="sm" onClick={() => to("document")}>
                <ArrowLeft size={15} />
                返回文档列表
              </Button>
            )}
          </div>
          <div className="workspace-actions">
            {view === "chat" && kb && (
              <Button
                ref={setHistoryAnchor}
                className="workspace-history"
                variant="ghost"
                size="sm"
                aria-label="历史对话"
                title="历史对话"
                aria-haspopup="dialog"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((value) => !value)}
              >
                <History size={17} />
                <span>历史</span>
              </Button>
            )}
            {view !== "settings" && (
              <Button
                className="workspace-search"
                variant="ghost"
                size="icon"
                aria-label="搜索知识"
                title="搜索知识 Ctrl+K"
                onClick={() => setSearchOpen(true)}
              >
                <Search size={17} />
              </Button>
            )}
            {view === "chat" && kb && (
              <Button
                className="browse-files"
                variant="ghost"
                size="sm"
                aria-expanded={referencesOpen}
                aria-label="浏览资料"
                onClick={openLibrary}
              >
                <FolderOpen size={16} />
                <span>浏览资料</span>
              </Button>
            )}
          </div>
        </header>
        <div className="workspace-content">
          {kb && (
            <div className="workspace-view chat-view" hidden={view !== "chat"}>
              <div
                className={`chat-workspace ${referencesOpen ? "references-open" : ""}`}
              >
                <div className="chat-main">
                  <Suspense fallback={<Loading />}>
                    <Chat
                      key={actualKbId}
                      kb={kb}
                      knowledgeBases={kbs.data || []}
                      folders={folders.data || []}
                      tags={tags.data || []}
                      onCitation={openCitation}
                      active={view === "chat"}
                      historyOpen={historyOpen && view === "chat"}
                      onHistoryOpenChange={setHistoryOpen}
                      historyAnchor={historyAnchor}
                    />
                  </Suspense>
                </div>
                {referencesOpen && (
                  <>
                    <div
                      className="resize-handle reference-resize"
                      role="separator"
                      aria-label="调整参考资料宽度"
                      aria-orientation="vertical"
                      aria-valuenow={filesWidth}
                      aria-valuemin={380}
                      aria-valuemax={680}
                      tabIndex={0}
                      onPointerDown={(event) => resize("files", event)}
                      onKeyDown={(event) => {
                        if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                          event.preventDefault();
                          ui.setWidths(
                            ui.libraryWidth,
                            filesWidth + (event.key === "ArrowLeft" ? 20 : -20),
                          );
                        }
                      }}
                    />
                    <ReferencePane
                      state={references}
                      dispatch={updateReferences}
                      active={view === "chat"}
                      onOpen={openDoc}
                    />
                  </>
                )}
              </div>
            </div>
          )}
          {view !== "chat" && (
            <div className="workspace-view">
              <Suspense fallback={<Loading />}>
                {view === "settings" ? (
                  <Settings kbId={actualKbId} />
                ) : view === "trash" && !kb ? (
                  <EmptyTrash />
                ) : !kb ? (
                  <Empty title="创建一个知识库">
                    点击“个人知识库”旁的加号，收集你的第一份资料。
                  </Empty>
                ) : view === "document" && selectedId ? (
                  <Reader
                    key={selectedId}
                    documentId={selectedId}
                    reader={reader}
                    onReader={(value) =>
                      setParams((previous) => {
                        const next = new URLSearchParams(previous);
                        if (value) next.set("mode", "read");
                        else next.delete("mode");
                        return next;
                      })
                    }
                    citation={
                      documentCitation?.document_id === selectedId
                        ? documentCitation
                        : undefined
                    }
                    folders={folders.data || []}
                    tags={tags.data || []}
                  />
                ) : (
                  <DocumentsPane
                    key={`${actualKbId}-${view}`}
                    kb={kb}
                    folders={folders.data || []}
                    tags={tags.data || []}
                    trash={view === "trash"}
                    layout="page"
                    selectedId=""
                    onOpen={openDoc}
                  />
                )}
              </Suspense>
            </div>
          )}
          {view === "chat" &&
            !kb &&
            (kbs.isPending ? (
              <Loading />
            ) : (
              <Empty title="欢迎来到知簇">
                创建知识库后即可上传文件并开始探索。
              </Empty>
            ))}
        </div>
      </main>
      {mobileLibrary && view !== "settings" && (
        <button
          className="mobile-overlay"
          aria-label="关闭侧栏"
          onClick={() => setMobileLibrary(false)}
        />
      )}
      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        kbId={actualKbId}
        onOpen={openCitation}
      />
    </div>
  );
}
