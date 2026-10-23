import { useState } from "react";
import { BookOpen, FolderPlus, MoreHorizontal, Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorText, json } from "../../lib/api";
import type { KnowledgeBase } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Menu, MenuItem } from "../../components/ui/menu";
type Edit = {
  id?: string;
  name: string;
  description?: string;
  version?: number;
};
export function Library({
  knowledgeBases,
  kbId,
  onSelect,
  trash,
}: {
  knowledgeBases: KnowledgeBase[];
  kbId: string;
  onSelect: (id: string) => void;
  trash: boolean;
}) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [remove, setRemove] = useState<KnowledgeBase | null>(null);
  const current = knowledgeBases.find((k) => k.id === kbId);
  const save = useMutation({
    mutationFn: async () => {
      if (!edit) return;
      const entity = await api<KnowledgeBase>(
        edit.id ? `/knowledge-bases/${edit.id}` : "/knowledge-bases",
        json(edit.id ? "PATCH" : "POST", {
          name: edit.name,
          description: edit.description,
          version: edit.version,
        }),
      );
      onSelect(entity.id);
    },
    onSuccess: () => {
      setEdit(null);
      void qc.invalidateQueries();
      toast.success("已保存");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const deletion = useMutation({
    mutationFn: () => api(`/knowledge-bases/${remove?.id}`, json("DELETE")),
    onSuccess: () => {
      setRemove(null);
      void qc.invalidateQueries();
      toast.success("已删除");
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <aside className="library-pane">
      <div className="section-heading">
        <span>个人知识库</span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="新建知识库"
          onClick={() => setEdit({ name: "", description: "" })}
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
      <Dialog
        open={!!edit}
        onOpenChange={(v) => !v && setEdit(null)}
        title={`${edit?.id ? "编辑" : "新建"}知识库`}
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
          <label>
            描述
            <textarea
              value={edit?.description || ""}
              onChange={(e) =>
                setEdit((v) =>
                  v ? { ...v, description: e.target.value } : null,
                )
              }
            />
          </label>
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
