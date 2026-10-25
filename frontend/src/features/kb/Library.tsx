import { useEffect, useState } from "react";
import { FolderPlus, MoreHorizontal, Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorText, json } from "../../lib/api";
import type { KnowledgeBase } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Menu, MenuItem } from "../../components/ui/menu";
import { KnowledgeBaseEditor, KnowledgeBaseIcon } from "./KnowledgeBaseEditor";
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
  const [edit, setEdit] = useState<KnowledgeBase | "new" | null>(null);
  useEffect(() => setEdit(null), [kbId]);
  const [remove, setRemove] = useState<KnowledgeBase | null>(null);
  const currentKb = knowledgeBases.find((k) => k.id === kbId);
  const deletion = useMutation({
    mutationFn: (submitted: KnowledgeBase) =>
      api(`/knowledge-bases/${submitted.id}`, json("DELETE")),
    onSuccess: async (_, submitted) => {
      await qc.invalidateQueries();
      setRemove((value) => (value === submitted ? null : value));
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
          onClick={() => setEdit("new")}
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
                <KnowledgeBaseIcon kb={k} />
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
                <MenuItem onSelect={() => setEdit(k)}>编辑知识库</MenuItem>
                <MenuItem danger onSelect={() => setRemove(k)}>
                  删除知识库
                </MenuItem>
              </Menu>
            </div>
          ))}
      </div>
      <KnowledgeBaseEditor
        open={!!edit}
        onOpenChange={(value) => !value && setEdit(null)}
        knowledgeBase={edit && edit !== "new" ? edit : undefined}
        onSaved={(entity) => onSelect(entity.id)}
      />
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
            onClick={() => remove && deletion.mutate(remove)}
          >
            确认删除
          </Button>
        </div>
      </Dialog>
      {currentKb && (
        <span className="sr-only">当前知识库 {currentKb.name}</span>
      )}
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
