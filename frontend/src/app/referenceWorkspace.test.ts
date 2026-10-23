import { expect, it } from "vitest";
import { emptyReferences, referenceReducer } from "./referenceWorkspace";
import type { ReferenceTab } from "./referenceWorkspace";

const tab: ReferenceTab = {
  id: "document-one",
  kind: "document",
  title: "原文",
  kb: { id: "kb", name: "资料库", description: "", version: 1 },
  documentId: "one",
  reader: true,
  citation: {
    document_id: "one",
    chunk_id: "chunk",
    anchors: { page_start: 3 },
    snippet: "引用",
  },
};
it("收起不丢文档与引用位置，展开恢复激活的资料", () => {
  const open = referenceReducer(emptyReferences, { type: "open", tab });
  const collapsed = referenceReducer(open, { type: "collapse" });
  expect(collapsed.collapsed).toBe(true);
  expect(collapsed.tabs[0]).toBe(tab);
  expect(collapsed.activeId).toBe(tab.id);
  const restored = referenceReducer(collapsed, { type: "expand" });
  expect(restored.collapsed).toBe(false);
  expect(restored.tabs[0].citation?.anchors?.page_start).toBe(3);
});
it("恢复最近文档会展开，但关闭最后标签和切换知识库会清理引用", () => {
  const other = { ...tab, id: "document-two", documentId: "two" };
  let state = referenceReducer(emptyReferences, { type: "open", tab });
  state = referenceReducer(state, { type: "open", tab: other });
  state = referenceReducer(state, { type: "collapse" });
  state = referenceReducer(state, { type: "activate", id: tab.id });
  expect(state.collapsed).toBe(false);
  state = referenceReducer(state, { type: "close", id: tab.id });
  expect(state.activeId).toBe(other.id);
  state = referenceReducer(state, { type: "close", id: other.id });
  expect(state.collapsed).toBe(true);
  expect(state.tabs).toEqual([]);
  expect(referenceReducer(state, { type: "clear" })).toBe(emptyReferences);
});
