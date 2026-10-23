import { useState } from "react";
import { BookOpen, ChevronDown, FolderOpen, Tags } from "lucide-react";
import type { Folder, KnowledgeBase, Tag } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Popover } from "../../components/ui/popover";
import { Checkbox } from "../../components/ui/checkbox";

function toggle(ids: string[], id: string, checked: boolean) {
  return checked ? [...ids, id] : ids.filter((value) => value !== id);
}

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
        <section className="scope-section" aria-labelledby="scope-kbs">
          <h3 id="scope-kbs">
            <BookOpen size={16} />
            知识库
          </h3>
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
        <section className="scope-section" aria-labelledby="scope-folders">
          <h3 id="scope-folders">
            <FolderOpen size={16} />
            文件夹<span>{currentKb.name}</span>
          </h3>
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
        <section className="scope-section" aria-labelledby="scope-tags">
          <h3 id="scope-tags">
            <Tags size={16} />
            标签<span>{currentKb.name} · 同时匹配所选标签</span>
          </h3>
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
