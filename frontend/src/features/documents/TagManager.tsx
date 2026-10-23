import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
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
            <label>
              颜色
              <input
                type="color"
                value={draft.color}
                onChange={(event) =>
                  setDraft({ ...draft, color: event.target.value })
                }
              />
            </label>
            <label>
              别名（英文逗号分隔）
              <input
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
          <div className="tag-manager-toolbar">
            <span className="muted">{tags.length} 个标签</span>
            <Button
              size="sm"
              onClick={() =>
                setDraft({ name: "", color: "#6366f1", aliases: "" })
              }
            >
              <Plus size={14} />
              新建标签
            </Button>
          </div>
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
              <p className="tag-manager-empty muted">还没有标签</p>
            )}
          </div>
          <div className="dialog-actions">
            <Button onClick={() => changeOpen(false)}>完成</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
