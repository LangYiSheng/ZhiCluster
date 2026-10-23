import { useId, useRef, useState } from "react";
import { BookOpen, ChevronDown, FolderOpen, Tags } from "lucide-react";
import type { Folder, KnowledgeBase, Tag } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Popover } from "../../components/ui/popover";
import { Checkbox } from "../../components/ui/checkbox";

function toggle(ids: string[], id: string, checked: boolean) {
  return checked ? [...ids, id] : ids.filter((value) => value !== id);
}

const scopeTabs = [
  { id: "kbs", label: "知识库", icon: BookOpen },
  { id: "folders", label: "文件夹", icon: FolderOpen },
  { id: "tags", label: "标签", icon: Tags },
] as const;
type ScopeTab = (typeof scopeTabs)[number]["id"];

export function ScopeSelector({
  knowledgeBases,
  folders,
  tags,
  currentKb,
  kbIds,
  folderIds,
  tagIds,
  includeDescendants,
  readOnly,
  disabled,
  onKbChange,
  onFoldersChange,
  onTagsChange,
  onIncludeDescendantsChange,
}: {
  knowledgeBases: KnowledgeBase[];
  folders: Folder[];
  tags: Tag[];
  currentKb: KnowledgeBase;
  kbIds: string[];
  folderIds: string[];
  tagIds: string[];
  includeDescendants: boolean;
  readOnly: boolean;
  disabled: boolean;
  onKbChange: (ids: string[]) => void;
  onFoldersChange: (ids: string[]) => void;
  onTagsChange: (ids: string[]) => void;
  onIncludeDescendantsChange: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ScopeTab>("kbs");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const currentFolders = folders.filter(
    (folder) => !folder.deleted_at && folder.kb_id === currentKb.id,
  );
  const otherFolderCount = folderIds.filter(
    (id) => !currentFolders.some((folder) => folder.id === id),
  ).length;
  const currentKbSelected = kbIds.includes(currentKb.id);
  const foldersDisabled = readOnly || !currentKbSelected;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="问答范围"
      side="top"
      align="start"
      className="scope-popover"
      trigger={
        <Button
          className="scope-selector"
          variant="ghost"
          size="sm"
          aria-label="调整问答范围"
          disabled={disabled}
        >
          <BookOpen size={14} />
          <span>
            问答范围 · {kbIds.length} 个知识库
            {folderIds.length ? ` · ${folderIds.length} 个文件夹` : ""}
            {tagIds.length ? ` · ${tagIds.length} 个标签` : ""}
          </span>
          <ChevronDown size={13} />
        </Button>
      }
    >
      <div className="scope-panel">
        {readOnly && (
          <p className="scope-saved-note">
            当前对话的范围已固定，可在历史中创建新对话来调整。
          </p>
        )}
        <div className="scope-tabs" role="tablist" aria-label="范围分类">
          {scopeTabs.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={`${id}-${item.id}-tab`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`${id}-${item.id}-panel`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight")
                  next = (index + 1) % scopeTabs.length;
                else if (event.key === "ArrowLeft")
                  next = (index + scopeTabs.length - 1) % scopeTabs.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = scopeTabs.length - 1;
                else return;
                event.preventDefault();
                setTab(scopeTabs[next].id);
                tabRefs.current[next]?.focus();
              }}
            >
              <item.icon size={14} aria-hidden="true" />
              {item.label}
              <span>
                {item.id === "kbs"
                  ? kbIds.length
                  : item.id === "folders"
                    ? folderIds.length
                    : tagIds.length}
              </span>
            </button>
          ))}
        </div>
        <section
          className="scope-section scope-tab-panel"
          id={`${id}-kbs-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-kbs-tab`}
          hidden={tab !== "kbs"}
          tabIndex={0}
        >
          <div className="scope-choice-grid">
            {knowledgeBases
              .filter((kb) => !kb.deleted_at)
              .map((kb) => (
                <label
                  className={`scope-choice ${kbIds.includes(kb.id) ? "is-selected" : ""}`}
                  key={kb.id}
                >
                  <Checkbox
                    disabled={readOnly}
                    checked={kbIds.includes(kb.id)}
                    onChange={(event) =>
                      onKbChange(toggle(kbIds, kb.id, event.target.checked))
                    }
                  />
                  <span>{kb.name}</span>
                </label>
              ))}
          </div>
          {!readOnly && !kbIds.length && (
            <p className="scope-empty">请至少选择一个知识库。</p>
          )}
        </section>
        <section
          className="scope-section scope-tab-panel"
          id={`${id}-folders-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-folders-tab`}
          hidden={tab !== "folders"}
          tabIndex={0}
        >
          <p className="scope-context">{currentKb.name}</p>
          <div className="scope-choice-grid">
            {currentFolders.map((folder) => (
              <label
                className={`scope-choice ${folderIds.includes(folder.id) ? "is-selected" : ""}`}
                key={folder.id}
              >
                <Checkbox
                  disabled={foldersDisabled}
                  checked={folderIds.includes(folder.id)}
                  onChange={(event) =>
                    onFoldersChange(
                      toggle(folderIds, folder.id, event.target.checked),
                    )
                  }
                />
                <span>{folder.name}</span>
              </label>
            ))}
          </div>
          {!currentFolders.length && (
            <p className="scope-empty">当前知识库暂无文件夹</p>
          )}
          {!readOnly && !kbIds.includes(currentKb.id) ? (
            <p className="scope-empty">选择当前知识库后可筛选文件夹。</p>
          ) : (
            <label className="checkbox-label scope-descendants">
              <Checkbox
                disabled={foldersDisabled}
                checked={includeDescendants}
                onChange={(event) =>
                  onIncludeDescendantsChange(event.target.checked)
                }
              />
              包含子文件夹
            </label>
          )}
          {!!otherFolderCount && (
            <p className="scope-empty">
              另有 {otherFolderCount} 个已保存的文件夹范围
            </p>
          )}
        </section>
        <section
          className="scope-section scope-tab-panel"
          id={`${id}-tags-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-tags-tab`}
          hidden={tab !== "tags"}
          tabIndex={0}
        >
          <p className="scope-context">{currentKb.name} · 同时匹配所选标签</p>
          <div className="scope-choice-grid">
            {tags
              .filter((tag) => !tag.deleted_at)
              .map((tag) => (
                <label
                  className={`scope-choice ${tagIds.includes(tag.id) ? "is-selected" : ""}`}
                  key={tag.id}
                >
                  <Checkbox
                    disabled={readOnly || !currentKbSelected}
                    checked={tagIds.includes(tag.id)}
                    onChange={(event) =>
                      onTagsChange(toggle(tagIds, tag.id, event.target.checked))
                    }
                  />
                  <span>{tag.name}</span>
                </label>
              ))}
          </div>
          {!tags.length && <p className="scope-empty">暂无标签</p>}
          {!readOnly && !currentKbSelected && (
            <p className="scope-empty">选择当前知识库后可筛选标签。</p>
          )}
        </section>
        <div className="scope-actions">
          <Button variant="default" onClick={() => setOpen(false)}>
            {readOnly ? "关闭范围" : "完成"}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
