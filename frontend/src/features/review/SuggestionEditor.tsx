import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Select } from "../../components/ui/select";
import { ErrorState, Loading } from "../../components/common";
import { api } from "../../lib/api";
import type { Folder, Tag } from "../../lib/api";
import type { ReviewSuggestion, SuggestionPayload } from "./api";
import { folderPath } from "./api";

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
  const [payload, setPayload] = useState(initial);
  const [newTags, setNewTags] = useState(initial.new_tag_names.join("，"));
  const metadata = useQuery({
    queryKey: ["review", "metadata", item.kb_id],
    queryFn: async () => {
      const [folders, tags] = await Promise.all([
        api<Folder[]>(`/knowledge-bases/${item.kb_id}/folders`),
        api<Tag[]>(`/knowledge-bases/${item.kb_id}/tags`),
      ]);
      return { folders, tags };
    },
  });
  const folders = metadata.data?.folders || [];
  const tags = metadata.data?.tags || [];
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="调整分类建议"
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
            const destination = final.proposed_folder_path
              ? `${final.proposed_folder_path}（新建）`
              : folderPath(final.existing_folder_id, folders);
            const labels = [
              ...tags
                .filter((tag) => final.existing_tag_ids.includes(tag.id))
                .map((tag) => tag.name),
              ...names,
            ];
            onSave(final, destination, labels);
          }}
        >
          <label>
            目标文件夹
            <Select
              aria-label="建议目标文件夹"
              value={payload.existing_folder_id || ""}
              onValueChange={(value) =>
                setPayload({
                  ...payload,
                  existing_folder_id: value || null,
                  proposed_folder_path: null,
                })
              }
              options={[
                { value: "", label: "未分类 / 使用新路径" },
                ...folders
                  .filter((folder) => !folder.deleted_at)
                  .map((folder) => ({
                    value: folder.id,
                    label: folderPath(folder.id, folders),
                  })),
              ]}
            />
          </label>
          <label>
            新建文件夹路径
            <input
              value={payload.proposed_folder_path || ""}
              placeholder="例如：研究 / 方法"
              onChange={(event) =>
                setPayload({
                  ...payload,
                  proposed_folder_path: event.target.value || null,
                  existing_folder_id: null,
                })
              }
            />
          </label>
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
