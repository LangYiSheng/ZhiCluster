import { lazy, Suspense, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { Dispatch, KeyboardEvent } from "react";
import { api } from "../lib/api";
import type { Document, Folder, Tag } from "../lib/api";
import { Button } from "../components/ui/button";
import { Loading } from "../components/common";
import { DocumentsPane } from "../features/documents/DocumentsPane";
import type {
  ReferenceAction,
  ReferenceState,
  ReferenceTab,
} from "./referenceWorkspace";

const Reader = lazy(() =>
  import("../features/documents/Reader").then((m) => ({ default: m.Reader })),
);

function ReferenceContent({
  tab,
  active,
  onReader,
  onOpen,
}: {
  tab: ReferenceTab;
  active: boolean;
  onReader: (reader: boolean) => void;
  onOpen: (doc: Document, reader?: boolean) => void;
}) {
  const folders = useQuery({
    queryKey: ["folders", tab.kb.id],
    queryFn: () =>
      api<Folder[]>(
        `/knowledge-bases/${tab.kb.id}/folders?include_deleted=true`,
      ),
  });
  const tags = useQuery({
    queryKey: ["tags", tab.kb.id],
    queryFn: () => api<Tag[]>(`/knowledge-bases/${tab.kb.id}/tags`),
  });
  return tab.kind === "library" ? (
    <DocumentsPane
      kb={tab.kb}
      folders={folders.data || []}
      tags={tags.data || []}
      trash={false}
      active={active}
      selectedId=""
      onOpen={onOpen}
    />
  ) : (
    <Suspense fallback={<Loading />}>
      <Reader
        documentId={tab.documentId!}
        active={active}
        citation={tab.citation}
        reader={tab.reader}
        onReader={onReader}
        folders={folders.data || []}
        tags={tags.data || []}
      />
    </Suspense>
  );
}

export function ReferencePane({
  state,
  dispatch,
  active,
  onOpen,
}: {
  state: ReferenceState;
  dispatch: Dispatch<ReferenceAction>;
  active: boolean;
  onOpen: (doc: Document, reader?: boolean) => void;
}) {
  const pane = useRef<HTMLElement>(null);
  const closeFocus = useRef(false);
  useEffect(() => {
    if (!closeFocus.current) return;
    closeFocus.current = false;
    const target = active
      ? pane.current?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        ) || pane.current?.querySelector<HTMLElement>(".reference-close")
      : document.querySelector<HTMLElement>(".reference-rail button");
    target?.focus();
  }, [active, state.activeId, state.tabs.length]);
  useEffect(() => {
    const element = pane.current;
    if (!active || !element) return;
    const narrow = window.matchMedia("(max-width: 780px)");
    const previous = document.activeElement as HTMLElement | null;
    let focusedOnMobile = false;
    const focusClose = () => {
      if (!narrow.matches) return;
      focusedOnMobile = true;
      element.querySelector<HTMLButtonElement>(".reference-close")?.focus();
    };
    focusClose();
    narrow.addEventListener("change", focusClose);
    return () => {
      narrow.removeEventListener("change", focusClose);
      if (focusedOnMobile || element.contains(document.activeElement)) {
        const target =
          focusedOnMobile &&
          previous?.isConnected &&
          !element.contains(previous)
            ? previous
            : document.querySelector<HTMLElement>(".reference-rail button");
        target?.focus();
      }
    };
  }, [active]);
  const multiple = state.tabs.length > 1;
  const selected = state.tabs.find((tab) => tab.id === state.activeId);
  if (!selected) return null;
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const count = state.tabs.length;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? count - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
    dispatch({ type: "activate", id: state.tabs[next].id });
    const buttons = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next].focus();
  }
  return (
    <aside
      ref={pane}
      className={`reference-pane ${multiple ? "has-tabs" : ""} ${!active ? "is-collapsed" : ""}`}
      aria-label="参考资料"
      aria-hidden={!active}
      inert={!active}
      onKeyDown={(event) => {
        if (
          !window.matchMedia("(max-width: 780px)").matches ||
          event.defaultPrevented ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          dispatch({ type: "collapse" });
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter(
          (element) => element.tabIndex >= 0 && element.getClientRects().length,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <Button
        className="reference-close"
        variant="ghost"
        size="icon"
        aria-label="关闭参考资料"
        title="收起资料侧栏，保留已打开的资料"
        onClick={() => dispatch({ type: "collapse" })}
      >
        <X size={17} />
      </Button>
      {multiple && (
        <div className="reference-tabs" role="tablist" aria-label="打开的资料">
          {state.tabs.map((tab, index) => (
            <div
              className={`reference-tab ${state.activeId === tab.id ? "is-active" : ""}`}
              key={tab.id}
            >
              <button
                id={`reference-tab-${tab.id}`}
                role="tab"
                aria-selected={state.activeId === tab.id}
                aria-controls={`reference-panel-${tab.id}`}
                tabIndex={state.activeId === tab.id ? 0 : -1}
                onClick={() => dispatch({ type: "activate", id: tab.id })}
                onKeyDown={(event) => tabKey(event, index)}
                title={tab.title}
              >
                {tab.title}
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`关闭 ${tab.title}`}
                onClick={() => {
                  closeFocus.current = true;
                  dispatch({ type: "close", id: tab.id });
                }}
              >
                <X size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="reference-content">
        {state.tabs.map((tab) => (
          <div
            className="reference-view"
            key={tab.id}
            id={`reference-panel-${tab.id}`}
            role="tabpanel"
            aria-label={!multiple ? tab.title : undefined}
            aria-labelledby={multiple ? `reference-tab-${tab.id}` : undefined}
            hidden={tab.id !== state.activeId}
          >
            <ReferenceContent
              tab={tab}
              active={active && tab.id === state.activeId}
              onOpen={onOpen}
              onReader={(reader) =>
                dispatch({ type: "reader", id: tab.id, reader })
              }
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
