import { lazy, Suspense, useEffect, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  BookOpen,
  ChevronRight,
  FileText,
  GitBranch,
  Menu as MenuIcon,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  Sun,
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
  const [tagId, setTagId] = useState("");
  const [trash, setTrash] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileFiles, setMobileFiles] = useState(false);
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
  useEffect(() => {
    document.documentElement.dataset.theme = ui.theme;
    document.documentElement.style.colorScheme = ui.theme;
  }, [ui.theme]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setMobileFiles(false);
        setMobileLibrary(false);
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  function chooseKb(id: string) {
    setSavedKb(id);
    localStorage.setItem("zhicluster-kb", id);
    setTagId("");
    setTrash(false);
    setMobileLibrary(false);
    setMobileFiles(false);
    setParams({ kb: id });
    setCitation(undefined);
    if (view === "document") navigate(`/chat?kb=${id}`);
  }
  function openDoc(doc: Document, read = false) {
    setReader(read);
    setCitation(undefined);
    setMobileFiles(false);
    navigate(`/document?kb=${actualKbId}&document=${doc.id}`);
  }
  function openCitation(c: Citation) {
    void api<Document>(`/documents/${c.document_id}`)
      .then((doc) => {
        setCitation(c);
        setReader(true);
        setMobileFiles(false);
        setSavedKb(doc.kb_id);
        localStorage.setItem("zhicluster-kb", doc.kb_id);
        setTagId("");
        setTrash(false);
        navigate(`/document?kb=${doc.kb_id}&document=${c.document_id}`);
      })
      .catch((e) => toast.error(errorText(e)));
  }
  function to(path: string) {
    setMobileFiles(false);
    setMobileLibrary(false);
    navigate(
      `/${path}?kb=${actualKbId}${selectedId ? `&document=${selectedId}` : ""}`,
    );
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
    "--files-width": `${ui.filesWidth}px`,
  } as CSSProperties;
  return (
    <div
      className={`app-shell ${!ui.sidebarOpen ? "sidebar-collapsed" : ""} ${mobileFiles ? "mobile-files-open" : ""} ${mobileLibrary ? "mobile-library-open" : ""}`}
      style={layoutStyle}
    >
      <nav className="nav-rail" aria-label="主导航">
        <img className="rail-logo" src="/favicon.svg" alt="知簇 ZhiCluster" />
        <div className="rail-top">
          <Button
            title="知识库"
            aria-label="知识库"
            size="icon"
            variant="ghost"
            className={view === "document" ? "active" : ""}
            onClick={() => {
              if (window.innerWidth <= 1023) {
                setMobileFiles(false);
                setMobileLibrary((v) => !v);
              } else ui.toggleSidebar();
            }}
          >
            <BookOpen size={20} />
          </Button>
          <Button
            title="搜索知识 Ctrl+K"
            aria-label="搜索知识"
            size="icon"
            variant="ghost"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={20} />
          </Button>
          <Button
            title="知识对话"
            aria-label="知识对话"
            size="icon"
            variant="ghost"
            className={view === "chat" ? "active" : ""}
            onClick={() => to("chat")}
          >
            <MessageSquare size={20} />
          </Button>
          <Button
            title="智能整理"
            aria-label="智能整理"
            size="icon"
            variant="ghost"
            className={view === "agent" ? "active" : ""}
            onClick={() => to("agent")}
          >
            <GitBranch size={20} />
          </Button>
        </div>
        <div className="rail-bottom">
          <Button
            title="切换主题"
            aria-label="切换主题"
            size="icon"
            variant="ghost"
            onClick={() => ui.setTheme(ui.theme === "light" ? "dark" : "light")}
          >
            {ui.theme === "light" ? <Moon size={19} /> : <Sun size={19} />}
          </Button>
          <Button
            title="设置"
            aria-label="设置"
            size="icon"
            variant="ghost"
            className={view === "settings" ? "active" : ""}
            onClick={() => to("settings")}
          >
            <Settings2 size={20} />
          </Button>
          <span className="rail-avatar">L</span>
        </div>
      </nav>
      <div className="library-slot">
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
            tags={tags.data || []}
            tagId={tagId}
            onTag={(id) => {
              setTagId(id);
              setTrash(false);
            }}
            onSearch={() => setSearchOpen(true)}
            onTrash={() => {
              setTrash(true);
              setMobileLibrary(false);
              setMobileFiles(true);
            }}
          />
        )}
      </div>
      <div
        className="resize-handle library-resize"
        role="separator"
        aria-label="调整知识库栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(e) => resize("library", e)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft")
            ui.setWidths(
              ui.libraryWidth + (e.key === "ArrowRight" ? 10 : -10),
              ui.filesWidth,
            );
        }}
      />
      {kb ? (
        <DocumentsPane
          key={`${actualKbId}-${trash}`}
          kb={kb}
          folders={folders.data || []}
          tags={tags.data || []}
          tagId={tagId}
          trash={trash}
          selectedId={selectedId}
          onOpen={openDoc}
        />
      ) : (
        <div className="documents-pane">
          <Empty title="创建一个知识库">点击左侧“个人知识库”旁的加号。</Empty>
        </div>
      )}
      <div
        className="resize-handle files-resize"
        role="separator"
        aria-label="调整文件栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(e) => resize("files", e)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft")
            ui.setWidths(
              ui.libraryWidth,
              ui.filesWidth + (e.key === "ArrowRight" ? 10 : -10),
            );
        }}
      />
      <main className="workspace">
        <header className="workspace-header">
          <div className="row gap breadcrumb">
            <Button
              className="desktop-sidebar-toggle"
              variant="ghost"
              size="icon"
              aria-label={ui.sidebarOpen ? "折叠知识库栏" : "展开知识库栏"}
              onClick={ui.toggleSidebar}
            >
              {ui.sidebarOpen ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
            </Button>
            <Button
              className="mobile-files-toggle"
              variant="ghost"
              size="icon"
              aria-label="显示文件管理"
              onClick={() => setMobileFiles((v) => !v)}
            >
              <MenuIcon size={17} />
            </Button>
            <BookOpen size={14} />
            <span>{kb?.name || "知识工作空间"}</span>
            <ChevronRight size={12} />
            <strong>
              {view === "chat"
                ? "知识对话"
                : view === "agent"
                  ? "智能整理"
                  : view === "settings"
                    ? "设置"
                    : "文档"}
            </strong>
          </div>
          <span className="private-indicator">
            <span className="online-dot" />
            本地私有
          </span>
        </header>
        <div className="workspace-tabs" role="tablist" aria-label="工作区视图">
          <button
            role="tab"
            aria-selected={view === "chat"}
            onClick={() => to("chat")}
          >
            <MessageSquare size={15} />
            对话
          </button>
          <button
            role="tab"
            aria-selected={view === "document"}
            onClick={() => to("document")}
          >
            <FileText size={15} />
            文档预览
          </button>
          <button
            role="tab"
            aria-selected={view === "agent"}
            onClick={() => to("agent")}
          >
            <GitBranch size={15} />
            智能整理
          </button>
        </div>
        <div className="workspace-content">
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
            ) : view === "document" ? (
              selectedId ? (
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
                  从文件列表选择文档查看摘要，双击进入阅读器。
                </Empty>
              )
            ) : (
              <Chat
                key={actualKbId}
                kb={kb}
                knowledgeBases={kbs.data || []}
                tags={tags.data || []}
                folders={folders.data || []}
                onCitation={openCitation}
              />
            )}
          </Suspense>
        </div>
        <footer className="workspace-footer">
          <span>知簇 ZhiCluster</span>
          <span>有迹可循的知识 · 有据可查的答案</span>
        </footer>
      </main>
      {(mobileFiles || mobileLibrary) && (
        <button
          className="mobile-overlay"
          aria-label="关闭侧栏"
          onClick={() => {
            setMobileFiles(false);
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
