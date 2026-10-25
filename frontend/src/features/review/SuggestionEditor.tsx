import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ErrorState, Loading } from "../../components/common";
import { api } from "../../lib/api";
import type { Tag } from "../../lib/api";
import type { ReviewSuggestion, SuggestionPayload } from "./api";

export function SuggestionEditor({
  item,
  initial,
  onClose,
  onSave,
}: {
  item: ReviewSuggestion;
  initial: SuggestionPayload;
  onClose: () => void;
  onSave: (
    payload: SuggestionPayload,
    destination: string,
    tags: string[],
  ) => void;
}) {
  const [payload, setPayload] = useState({
    ...initial,
    existing_folder_id: null,
    proposed_folder_path: null,
  });
  const [newTags, setNewTags] = useState(initial.new_tag_names.join("，"));
  const metadata = useQuery({
    queryKey: ["review", "suggestion-tags", item.kb_id],
    queryFn: async () => {
      const tags = await api<Tag[]>(`/knowledge-bases/${item.kb_id}/tags`);
      return { tags };
    },
  });
  const tags = metadata.data?.tags || [];
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="调整标签建议"
      description={item.document_name}
    >
      {metadata.isPending ? (
        <Loading />
      ) : metadata.isError ? (
        <ErrorState
          error={metadata.error}
          retry={() => void metadata.refetch()}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const names = [
              ...new Set(
                newTags
                  .split(/[,，]/)
                  .map((name) => name.trim())
                  .filter(Boolean),
              ),
            ];
            const final = { ...payload, new_tag_names: names };
            const destination = item.current_folder_path || "知识库根目录";
            const labels = [
              ...tags
                .filter((tag) => final.existing_tag_ids.includes(tag.id))
                .map((tag) => tag.name),
              ...names,
            ];
            onSave(final, destination, labels);
          }}
        >
          <p className="review-note">标签建议不改变文档所在文件夹。</p>
          {!!tags.length && (
            <fieldset className="review-tag-options">
              <legend>添加已有标签</legend>
              {tags.map((tag) => (
                <label className="checkbox-label" key={tag.id}>
                  <Checkbox
                    checked={payload.existing_tag_ids.includes(tag.id)}
                    onChange={(event) =>
                      setPayload({
                        ...payload,
                        existing_tag_ids: event.target.checked
                          ? [...payload.existing_tag_ids, tag.id]
                          : payload.existing_tag_ids.filter(
                              (id) => id !== tag.id,
                            ),
                      })
                    }
                  />
                  {tag.name}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            新增标签
            <input
              value={newTags}
              placeholder="用逗号分隔"
              onChange={(event) => setNewTags(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <Button type="button" onClick={onClose}>
              取消
            </Button>
            <Button variant="default" type="submit">
              保留调整
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
