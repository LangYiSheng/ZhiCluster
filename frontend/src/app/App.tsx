import { lazy, Suspense, useEffect, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  FileText,
  FolderOpen,
  GitBranch,
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
import { api, errorText } from "../lib/api";
import { toast } from "sonner";
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

const Reader = lazy(() =>
  import("../features/documents/Reader").then((m) => ({ default: m.Reader })),
);
const Chat = lazy(() =>
  import("../features/chat/Chat").then((m) => ({ default: m.Chat })),
);
const Agent = lazy(() =>
  import("../features/agent/Agent").then((m) => ({ default: m.Agent })),
);
const Settings = lazy(() =>
  import("../features/settings/Settings").then((m) => ({
    default: m.Settings,
  })),
);

export function App() {
  const ui = useUI();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [savedKb, setSavedKb] = useState(
    () => localStorage.getItem("zhicluster-kb") || "",
  );
  const [trash, setTrash] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(location.pathname === "/document");
  const [mobileLibrary, setMobileLibrary] = useState(false);
  const [reader, setReader] = useState(false);
  const [citation, setCitation] = useState<Citation | undefined>();
  const kbs = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: () => api<KnowledgeBase[]>("/knowledge-bases"),
  });
  const kbId = params.get("kb") || savedKb || kbs.data?.[0]?.id || "";
  const kb = kbs.data?.find((k) => k.id === kbId) || kbs.data?.[0];
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
  const view =
    location.pathname === "/settings"
      ? "settings"
      : location.pathname === "/agent"
        ? "agent"
        : location.pathname === "/document"
          ? "document"
          : "chat";
  const viewName =
    view === "chat"
      ? "知识对话"
      : view === "agent"
        ? "智能整理"
        : view === "settings"
          ? "设置"
          : "文档管理";

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
    function key(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setFilesOpen(false);
        setMobileLibrary(false);
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  function chooseKb(id: string) {
    setSavedKb(id);
    localStorage.setItem("zhicluster-kb", id);
    setTrash(false);
    setHistoryOpen(false);
    setMobileLibrary(false);
    setParams({ kb: id });
    setCitation(undefined);
    if (view === "document") setFilesOpen(true);
  }
  function openDoc(doc: Document, read = false) {
    setReader(read);
    setCitation(undefined);
    if (window.innerWidth <= 1023) setFilesOpen(false);
    navigate(`/document?kb=${actualKbId}&document=${doc.id}`);
  }
  function openCitation(c: Citation) {
    void api<Document>(`/documents/${c.document_id}`)
      .then((doc) => {
        setCitation(c);
        setReader(true);
        setFilesOpen(false);
        setSavedKb(doc.kb_id);
        localStorage.setItem("zhicluster-kb", doc.kb_id);
        setTrash(false);
        setHistoryOpen(false);
        navigate(`/document?kb=${doc.kb_id}&document=${c.document_id}`);
      })
      .catch((e) => toast.error(errorText(e)));
  }
  function to(path: string) {
    setHistoryOpen(false);
    setMobileLibrary(false);
    setFilesOpen(path === "document");
    navigate(
      `/${path}?kb=${actualKbId}${selectedId ? `&document=${selectedId}` : ""}`,
    );
  }
  function toggleLibrary() {
    if (window.innerWidth <= 1023) {
      setFilesOpen(false);
      setMobileLibrary((v) => !v);
    } else ui.toggleSidebar();
  }
  function toggleFiles() {
    setMobileLibrary(false);
    setFilesOpen((v) => !v);
  }
  function resize(
    kind: "library" | "files",
    event: PointerEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    const start = event.clientX;
    const initial = kind === "library" ? ui.libraryWidth : ui.filesWidth;
    function move(e: globalThis.PointerEvent) {
      const width = initial + e.clientX - start;
      ui.setWidths(
        kind === "library" ? width : ui.libraryWidth,
        kind === "files" ? width : ui.filesWidth,
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
    "--files-width": `${filesOpen ? ui.filesWidth : 0}px`,
  } as CSSProperties;
  return (
    <div
      className={`app-shell ${!ui.sidebarOpen ? "sidebar-collapsed" : ""} ${filesOpen ? "files-open" : ""} ${mobileLibrary ? "mobile-library-open" : ""} ${view === "settings" ? "settings-mode" : ""}`}
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
            aria-label="知识库"
            aria-current={view === "document" ? "page" : undefined}
            onClick={() => to("document")}
          >
            <FileText size={18} />
            文档管理
          </button>
          <button
            aria-current={view === "agent" ? "page" : undefined}
            onClick={() => to("agent")}
          >
            <GitBranch size={18} />
            智能整理
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
              trash={trash}
              onSelect={chooseKb}
            />
          )}
        </div>
        <div className="sidebar-tools">
          <button onClick={() => to("settings")}>
            <Settings2 size={17} />
            设置
          </button>
          <button
            className={trash ? "active" : ""}
            aria-pressed={trash}
            disabled={!actualKbId}
            onClick={() => {
              setTrash(true);
              setMobileLibrary(false);
              setFilesOpen(true);
            }}
          >
            <Trash2 size={17} />
            回收站
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
        onPointerDown={(e) => resize("library", e)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            ui.setWidths(
              ui.libraryWidth + (e.key === "ArrowRight" ? 10 : -10),
              ui.filesWidth,
            );
          }
        }}
      />
      <section
        className="context-pane"
        aria-label="资料浏览"
        hidden={view === "settings" || !filesOpen}
      >
        <div className="context-pane-heading">
          <span>
            <FolderOpen size={16} />
            浏览资料
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭资料浏览"
            onClick={() => setFilesOpen(false)}
          >
            <X size={17} />
          </Button>
        </div>
        {kb ? (
          <DocumentsPane
            key={`${actualKbId}-${trash}`}
            kb={kb}
            folders={folders.data || []}
            tags={tags.data || []}
            active={view !== "settings" && filesOpen}
            trash={trash}
            selectedId={selectedId}
            onOpen={openDoc}
          />
        ) : (
          <div className="documents-pane">
            <Empty title="创建一个知识库">
              点击“个人知识库”旁的加号，收集你的第一份资料。
            </Empty>
          </div>
        )}
      </section>
      <div
        className="resize-handle files-resize"
        hidden={view === "settings" || !filesOpen}
        role="separator"
        aria-label="调整文件栏宽度"
        aria-orientation="vertical"
        aria-valuenow={ui.filesWidth}
        aria-valuemin={280}
        aria-valuemax={500}
        tabIndex={0}
        onPointerDown={(e) => resize("files", e)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            ui.setWidths(
              ui.libraryWidth,
              ui.filesWidth + (e.key === "ArrowRight" ? 10 : -10),
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
                <BookOpen size={14} />
                <span>{kb?.name || "知识工作空间"}</span>
                <ChevronRight size={12} />
              </>
            )}
            <strong>{viewName}</strong>
          </div>
          <div className="workspace-actions">
            {view === "chat" && kb && (
              <Button
                className="workspace-history"
                variant="ghost"
                size="sm"
                aria-label="历史对话"
                title="历史对话"
                aria-haspopup="dialog"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen(true)}
              >
                <History size={17} />
                <span>历史</span>
              </Button>
            )}
            {view !== "settings" && (
              <>
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
                <Button
                  className="browse-files"
                  variant="ghost"
                  size="sm"
                  aria-expanded={filesOpen}
                  aria-label="浏览资料"
                  onClick={toggleFiles}
                >
                  <FolderOpen size={16} />
                  <span>浏览资料</span>
                </Button>
              </>
            )}
          </div>
        </header>
        <div className="workspace-content">
          {kb && (
            <div className="workspace-view" hidden={view !== "chat"}>
              <Suspense fallback={<Loading />}>
                <Chat
                  key={actualKbId}
                  kb={kb}
                  knowledgeBases={kbs.data || []}
                  tags={tags.data || []}
                  folders={folders.data || []}
                  onCitation={openCitation}
                  active={view === "chat"}
                  historyOpen={historyOpen && view === "chat"}
                  onHistoryOpenChange={setHistoryOpen}
                />
              </Suspense>
            </div>
          )}
          {view !== "chat" && (
            <div className="workspace-view">
              <Suspense fallback={<Loading />}>
                {view === "settings" ? (
                  <Settings kbId={actualKbId} />
                ) : !kb ? (
                  <Empty title="欢迎来到知簇">
                    创建知识库后即可上传文件并开始探索。
                  </Empty>
                ) : view === "agent" ? (
                  <Agent
                    key={actualKbId}
                    kbId={actualKbId}
                    folders={folders.data || []}
                    tags={tags.data || []}
                  />
                ) : selectedId ? (
                  <Reader
                    key={selectedId}
                    documentId={selectedId}
                    reader={reader}
                    onReader={setReader}
                    citation={citation}
                    folders={folders.data || []}
                    tags={tags.data || []}
                  />
                ) : (
                  <Empty title="打开一份文档">
                    在“浏览资料”中选择文档，查看摘要或打开阅读器。
                    <Button onClick={() => setFilesOpen(true)}>
                      <FolderOpen size={16} />
                      浏览资料
                    </Button>
                  </Empty>
                )}
              </Suspense>
            </div>
          )}
          {view === "chat" && !kb && (
            <Empty title="欢迎来到知簇">
              创建知识库后即可上传文件并开始探索。
            </Empty>
          )}
        </div>
      </main>
      {(filesOpen || mobileLibrary) && view !== "settings" && (
        <button
          className="mobile-overlay"
          aria-label="关闭侧栏"
          onClick={() => {
            setFilesOpen(false);
            setMobileLibrary(false);
          }}
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
