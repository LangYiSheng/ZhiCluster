import { useState } from "react";
import {
  BookOpen,
  ChevronDown,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorText, json } from "../../lib/api";
import type { KnowledgeBase, Tag } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Menu, MenuItem } from "../../components/ui/menu";
type Edit = {
  kind: "kb" | "tag";
  id?: string;
  name: string;
  description?: string;
  color?: string;
  aliases?: string;
  version?: number;
};
export function Library({
  knowledgeBases,
  kbId,
  onSelect,
  tags,
  tagId,
  onTag,
  onSearch,
  onTrash,
  trash,
}: {
  knowledgeBases: KnowledgeBase[];
  kbId: string;
  onSelect: (id: string) => void;
  tags: Tag[];
  tagId: string;
  onTag: (id: string) => void;
  onSearch: () => void;
  onTrash: () => void;
  trash: boolean;
}) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [remove, setRemove] = useState<KnowledgeBase | Tag | null>(null);
  const current = knowledgeBases.find((k) => k.id === kbId);
  const save = useMutation({
    mutationFn: async () => {
      if (!edit) return;
      const body =
        edit.kind === "kb"
          ? {
              name: edit.name,
              description: edit.description,
              version: edit.version,
            }
          : {
              name: edit.name,
              color: edit.color,
              aliases: edit.aliases
                ?.split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              version: edit.version,
            };
      const path =
        edit.kind === "kb"
          ? edit.id
            ? `/knowledge-bases/${edit.id}`
            : "/knowledge-bases"
          : edit.id
            ? `/tags/${edit.id}`
            : `/knowledge-bases/${kbId}/tags`;
      const entity = await api<KnowledgeBase | Tag>(
        path,
        json(edit.id ? "PATCH" : "POST", body),
      );
      if (edit.kind === "kb") onSelect(entity.id);
    },
    onSuccess: () => {
      setEdit(null);
      void qc.invalidateQueries();
      toast.success("已保存");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const deletion = useMutation({
    mutationFn: () =>
      api(
        `/${"description" in (remove || {}) ? "knowledge-bases" : "tags"}/${remove?.id}`,
        json("DELETE"),
      ),
    onSuccess: () => {
      setRemove(null);
      void qc.invalidateQueries();
      toast.success("已删除");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <aside className="library-pane">
      <div className="brand-text">
        <img src="/favicon.svg" alt="" />
        <div>
          <strong>知簇</strong>
          <small>你的知识，自成一簇</small>
        </div>
      </div>
      <button className="quick-search" onClick={onSearch}>
        <Search size={16} />
        <span>搜索知识</span>
        <kbd>⌘ K</kbd>
      </button>
      <div className="section-heading">
        <span>个人知识库</span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="新建知识库"
          onClick={() => setEdit({ kind: "kb", name: "", description: "" })}
        >
          <Plus size={15} />
        </Button>
      </div>
      <div className="library-list">
        {knowledgeBases
          .filter((k) => !k.deleted_at)
          .map((k) => (
            <div
              key={k.id}
              className={`library-item ${kbId === k.id && !trash ? "active" : ""}`}
            >
              <button onClick={() => onSelect(k.id)}>
                <BookOpen size={17} />
                <span>{k.name}</span>
              </button>
              <Menu
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${k.name}菜单`}
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                }
              >
                <MenuItem
                  onSelect={() =>
                    setEdit({
                      kind: "kb",
                      id: k.id,
                      name: k.name,
                      description: k.description,
                      version: k.version,
                    })
                  }
                >
                  修改名称与描述
                </MenuItem>
                <MenuItem danger onSelect={() => setRemove(k)}>
                  删除知识库
                </MenuItem>
              </Menu>
            </div>
          ))}
      </div>
      <button
        className={`sidebar-link ${trash ? "active" : ""}`}
        onClick={onTrash}
      >
        <Trash2 size={16} />
        回收站
      </button>
      <div className="divider" />
      <div className="section-heading">
        <span>
          标签 <ChevronDown size={12} />
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="新建标签"
          disabled={!kbId}
          onClick={() =>
            setEdit({ kind: "tag", name: "", color: "#6366f1", aliases: "" })
          }
        >
          <Plus size={15} />
        </Button>
      </div>
      <div className="tag-list">
        <button
          className={`tag-item ${!tagId ? "selected" : ""}`}
          onClick={() => onTag("")}
        >
          <TagIcon size={14} />
          全部标签
        </button>
        {tags.map((t) => (
          <div
            className={`tag-row ${tagId === t.id ? "selected" : ""}`}
            key={t.id}
          >
            <button
              className="tag-item"
              onClick={() => onTag(tagId === t.id ? "" : t.id)}
            >
              <span className="tag-dot" style={{ background: t.color }} />
              {t.name}
            </button>
            <Menu
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t.name}标签菜单`}
                >
                  <MoreHorizontal size={14} />
                </Button>
              }
            >
              <MenuItem
                onSelect={() =>
                  setEdit({
                    kind: "tag",
                    id: t.id,
                    name: t.name,
                    color: t.color,
                    aliases: t.aliases?.join(", "),
                    version: t.version,
                  })
                }
              >
                编辑标签
              </MenuItem>
              <MenuItem danger onSelect={() => setRemove(t)}>
                删除标签
              </MenuItem>
            </Menu>
          </div>
        ))}
      </div>
      <div className="library-bottom">
        <div className="avatar">我</div>
        <div>
          <strong>我的个人空间</strong>
          <small>本地优先 · 私有知识</small>
        </div>
        <span className="online-dot" />
      </div>
      <Dialog
        open={!!edit}
        onOpenChange={(v) => !v && setEdit(null)}
        title={`${edit?.id ? "编辑" : "新建"}${edit?.kind === "kb" ? "知识库" : "标签"}`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label>
            名称
            <input
              required
              maxLength={100}
              autoFocus
              value={edit?.name || ""}
              onChange={(e) =>
                setEdit((v) => (v ? { ...v, name: e.target.value } : null))
              }
            />
          </label>
          {edit?.kind === "kb" ? (
            <label>
              描述
              <textarea
                value={edit.description || ""}
                onChange={(e) =>
                  setEdit((v) =>
                    v ? { ...v, description: e.target.value } : null,
                  )
                }
              />
            </label>
          ) : (
            <>
              <label>
                颜色
                <input
                  type="color"
                  value={edit?.color || "#6366f1"}
                  onChange={(e) =>
                    setEdit((v) => (v ? { ...v, color: e.target.value } : null))
                  }
                />
              </label>
              <label>
                别名（英文逗号分隔）
                <input
                  value={edit?.aliases || ""}
                  onChange={(e) =>
                    setEdit((v) =>
                      v ? { ...v, aliases: e.target.value } : null,
                    )
                  }
                />
              </label>
            </>
          )}
          <div className="dialog-actions">
            <Button type="button" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button
              variant="default"
              disabled={save.isPending || !edit?.name.trim()}
            >
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!remove}
        onOpenChange={(v) => !v && setRemove(null)}
        title="确认删除"
        description={`将删除“${remove?.name}”。知识库可在回收站恢复。`}
      >
        <div className="dialog-actions">
          <Button onClick={() => setRemove(null)}>取消</Button>
          <Button
            variant="danger"
            disabled={deletion.isPending}
            onClick={() => deletion.mutate()}
          >
            确认删除
          </Button>
        </div>
      </Dialog>
      {current && <span className="sr-only">当前知识库 {current.name}</span>}
    </aside>
  );
}
export function CreateLibraryEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <FolderPlus size={30} />
      <h2>建立你的第一簇知识</h2>
      <p className="muted">创建知识库，开始收集与整理真实文档。</p>
      <Button variant="default" onClick={onCreate}>
        创建知识库
      </Button>
    </div>
  );
}
