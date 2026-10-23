import type { Citation, KnowledgeBase } from "../lib/api";

export type ReferenceTab = {
  id: string;
  kind: "library" | "document";
  title: string;
  kb: KnowledgeBase;
  documentId?: string;
  citation?: Citation;
  reader: boolean;
};
export type ReferenceState = {
  tabs: ReferenceTab[];
  activeId: string;
  collapsed?: boolean;
};
export type ReferenceAction =
  | { type: "open"; tab: ReferenceTab }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "reader"; id: string; reader: boolean }
  | { type: "collapse" }
  | { type: "expand" }
  | { type: "clear" };

export const emptyReferences: ReferenceState = {
  tabs: [],
  activeId: "",
  collapsed: true,
};

export function referenceReducer(
  state: ReferenceState,
  action: ReferenceAction,
): ReferenceState {
  switch (action.type) {
    case "open": {
      const exists = state.tabs.some((tab) => tab.id === action.tab.id);
      return {
        tabs: exists
          ? state.tabs.map((tab) =>
              tab.id === action.tab.id ? action.tab : tab,
            )
          : [...state.tabs, action.tab],
        activeId: action.tab.id,
        collapsed: false,
      };
    }
    case "activate":
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeId: action.id, collapsed: false }
        : state;
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      return {
        tabs,
        collapsed: !tabs.length || state.collapsed,
        activeId:
          state.activeId === action.id
            ? tabs[Math.min(index, tabs.length - 1)]?.id || ""
            : state.activeId,
      };
    }
    case "reader":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.id ? { ...tab, reader: action.reader } : tab,
        ),
      };
    case "clear":
      return emptyReferences;
    case "collapse":
      return { ...state, collapsed: true };
    case "expand":
      return state.tabs.length ? { ...state, collapsed: false } : state;
  }
}
