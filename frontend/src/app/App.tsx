import { lazy, Suspense, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
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
  ListTodo,
  ListChecks,
  Menu as MenuIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, errorText } from "../lib/api";
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
import { NavigationRail } from "./NavigationRail";
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
const Tasks = lazy(() =>
  import("../features/tasks/Tasks").then((m) => ({ default: m.Tasks })),
);
const Review = lazy(() =>
  import("../features/review/Review").then((m) => ({ default: m.Review })),
);

const Trash = lazy(() =>
  import("../features/trash/Trash").then((m) => ({ default: m.Trash })),
);

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
        : location.pathname === "/tasks"
          ? "tasks"
          : location.pathname === "/review"
            ? "review"
            : location.pathname === "/document"
              ? "document"
              : "chat";
  const viewName =
    view === "settings"
      ? "设置"
      : view === "trash"
        ? "回收站"
        : view === "tasks"
          ? "任务列表"
          : view === "review"
            ? "整理审阅"
            : view === "document"
              ? "文档管理"
              : "知识对话";
  const referencesOpen = references.tabs.length > 0 && !references.collapsed;
  const [resizing, setResizing] = useState(false);
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
    citationRequest.current += 1;
    dispatchReference(action);
  }
  function chooseKb(id: string) {
    setSavedKb(id);
    localStorage.setItem("zhicluster-kb", id);
    setHistoryOpen(false);
    setMobileLibrary(false);
    setDocumentCitation(undefined);
    updateReferences({ type: "clear" });
    setParams(
      view === "review"
        ? { kb: id, filter_kb: id, tab: params.get("tab") || "suggestions" }
        : { kb: id },
    );
  }
  function to(path: string) {
    citationRequest.current += 1;
    setMobileLibrary(false);
    setHistoryOpen(false);
    navigate(`/${path}${actualKbId ? `?kb=${actualKbId}` : ""}`);
  }
  function openLibrary() {
    if (!kb) return;
    citationRequest.current += 1;
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
    citationRequest.current += 1;
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
    setResizing(true);
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
      document.removeEventListener("pointercancel", stop);
      setResizing(false);
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
    document.addEventListener("pointercancel", stop, { once: true });
  }
  const layoutStyle = {
    "--library-width": `${ui.sidebarOpen ? ui.libraryWidth : 56}px`,
    "--library-panel-width": `${ui.libraryWidth}px`,
    "--reference-width": `${filesWidth}px`,
    "--reference-column":
      view === "chat" && kb && referencesOpen
        ? "calc(min(var(--reference-width), 43vw) + 14px)"
        : "0px",
  } as CSSProperties;
  if (location.pathname === "/agent")
    return <Navigate replace to={`/chat${kbId ? `?kb=${kbId}` : ""}`} />;
  return (
    <div
      className={`app-shell ${!ui.sidebarOpen ? "sidebar-collapsed" : ""} ${mobileLibrary ? "mobile-library-open" : ""} ${view === "settings" ? "settings-mode" : ""} ${referencesOpen && view === "chat" ? "references-open" : ""} ${resizing ? "is-resizing" : ""}`}
      style={layoutStyle}
    >
      <NavigationRail
        view={view}
        onNavigate={to}
        onExpand={toggleLibrary}
        hidden={view === "settings"}
        inert={mobileLibrary}
      />
      <aside
        className="library-slot"
        aria-label="知识库与主导航"
        hidden={view === "settings"}
        inert={!ui.sidebarOpen && !mobileLibrary}
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
            aria-current={view === "review" ? "page" : undefined}
            onClick={() => to("review")}
          >
            <ListChecks size={17} />
            整理审阅
          </button>
          <button
            aria-current={view === "tasks" ? "page" : undefined}
            onClick={() => to("tasks")}
          >
            <ListTodo size={17} />
            任务列表
          </button>
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
              <div className="browse-actions">
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
                <Button
                  className="reference-toggle"
                  variant="ghost"
                  size="icon"
                  aria-label={referencesOpen ? "收起资料侧栏" : "展开资料侧栏"}
                  title={referencesOpen ? "收起资料侧栏" : "展开资料侧栏"}
                  aria-expanded={referencesOpen}
                  onClick={() =>
                    referencesOpen
                      ? updateReferences({ type: "collapse" })
                      : references.tabs.length
                        ? updateReferences({ type: "expand" })
                        : openLibrary()
                  }
                >
                  <PanelRightOpen
                    size={17}
                    className={referencesOpen ? "reference-collapse-icon" : ""}
                  />
                </Button>
              </div>
            )}
          </div>
        </header>
        <div className="workspace-content">
          {kb && (
            <div className="workspace-view chat-view" hidden={view !== "chat"}>
              <div className="chat-workspace">
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
              </div>
            </div>
          )}
          {view !== "chat" && (
            <div className="workspace-view">
              <Suspense fallback={<Loading />}>
                {view === "settings" ? (
                  <Settings kbId={actualKbId} />
                ) : view === "tasks" ? (
                  <Tasks kb={kb || null} documentId={selectedId || undefined} />
                ) : view === "review" ? (
                  <Review
                    knowledgeBases={kbs.data || []}
                    currentKbId={actualKbId}
                  />
                ) : view === "trash" ? (
                  <Trash />
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
                    trash={false}
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
      {kb && (
        <>
          <div
            className="resize-handle reference-resize"
            hidden={view !== "chat" || !referencesOpen}
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
          <div className="reference-dock" hidden={view !== "chat"}>
            <ReferencePane
              state={references}
              dispatch={updateReferences}
              active={view === "chat" && referencesOpen}
              onOpen={openDoc}
            />
          </div>
        </>
      )}
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
