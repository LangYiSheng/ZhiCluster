import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { ColorPicker } from "../../components/ui/color-picker";
import { api, errorText, json } from "../../lib/api";
import type { Tag } from "../../lib/api";

type TagDraft = {
  id?: string;
  name: string;
  color: string;
  aliases: string;
  version?: number;
};

export function TagManager({
  kbId,
  tags,
  open,
  onOpenChange,
  onDelete,
}: {
  kbId: string;
  tags: Tag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<TagDraft | null>(null);
  const [removing, setRemoving] = useState<Tag | null>(null);
  const save = useMutation({
    mutationFn: async (value: TagDraft) =>
      api<Tag>(
        value.id ? `/tags/${value.id}` : `/knowledge-bases/${kbId}/tags`,
        json(value.id ? "PATCH" : "POST", {
          name: value.name.trim(),
          color: value.color,
          aliases: value.aliases
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          version: value.version,
        }),
      ),
    onSuccess: () => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: ["tags", kbId] });
      void client.invalidateQueries({ queryKey: ["documents", kbId] });
      toast.success("标签已保存");
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const remove = useMutation({
    mutationFn: (tag: Tag) => api(`/tags/${tag.id}`, json("DELETE")),
    onSuccess: (_, tag) => {
      setRemoving(null);
      onDelete(tag.id);
      void client.invalidateQueries();
      toast.success("标签已删除");
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const busy = save.isPending || remove.isPending;
  function changeOpen(value: boolean) {
    if (busy) return;
    if (!value) {
      setDraft(null);
      setRemoving(null);
    }
    onOpenChange(value);
  }
  return (
    <Dialog
      className="tag-manager-dialog"
      open={open}
      onOpenChange={changeOpen}
      title={
        draft
          ? draft.id
            ? "编辑标签"
            : "新建标签"
          : removing
            ? "删除标签"
            : "管理标签"
      }
      description={
        removing ? `删除“${removing.name}”后，文档会移除此标签。` : undefined
      }
    >
      {draft ? (
        <form
          className="tag-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.name.trim() && !busy) save.mutate(draft);
          }}
        >
          <fieldset disabled={busy} className="tag-editor-fields">
            <label>
              名称
              <input
                required
                maxLength={100}
                autoFocus
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <div className="tag-editor-color">
              <span>颜色</span>
              <ColorPicker
                label="颜色"
                value={draft.color}
                onChange={(color) => setDraft({ ...draft, color })}
              />
              <span className="tag-editor-preview">
                <span className="tag-dot" style={{ background: draft.color }} />
                {draft.name.trim() || "标签预览"}
              </span>
            </div>
            <label>
              别名（英文逗号分隔）
              <input
                placeholder="例如：人工智能, AI"
                value={draft.aliases}
                onChange={(event) =>
                  setDraft({ ...draft, aliases: event.target.value })
                }
              />
            </label>
          </fieldset>
          <div className="dialog-actions">
            <Button
              type="button"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              返回
            </Button>
            <Button variant="default" disabled={busy || !draft.name.trim()}>
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      ) : removing ? (
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => setRemoving(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => remove.mutate(removing)}
          >
            {remove.isPending ? "删除中…" : "确认删除"}
          </Button>
        </div>
      ) : (
        <>
          {!!tags.length && (
            <div className="tag-manager-toolbar">
              <span className="muted">{tags.length} 个标签</span>
              <Button
                size="sm"
                variant="default"
                onClick={() =>
                  setDraft({ name: "", color: "#6366f1", aliases: "" })
                }
              >
                <Plus size={14} />
                新建标签
              </Button>
            </div>
          )}
          <div className="tag-manager-list">
            {tags.map((tag) => (
              <div className="tag-manager-row" key={tag.id}>
                <span className="tag-dot" style={{ background: tag.color }} />
                <div className="tag-manager-name">
                  <strong>{tag.name}</strong>
                  {!!tag.aliases?.length && (
                    <small>{tag.aliases.join("、")}</small>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`编辑 ${tag.name}`}
                  onClick={() =>
                    setDraft({
                      id: tag.id,
                      name: tag.name,
                      color: tag.color,
                      aliases: tag.aliases?.join(", ") || "",
                      version: tag.version,
                    })
                  }
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`删除 ${tag.name}`}
                  onClick={() => setRemoving(tag)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            {!tags.length && (
              <div className="tag-manager-empty">
                <span className="tag-manager-empty-icon" aria-hidden="true">
                  <Tags size={24} strokeWidth={1.5} />
                </span>
                <strong>还没有标签</strong>
                <p>为资料添加标签，让分类和查找更方便。</p>
                <Button
                  variant="default"
                  onClick={() =>
                    setDraft({ name: "", color: "#6366f1", aliases: "" })
                  }
                >
                  <Plus size={15} />
                  新建标签
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
