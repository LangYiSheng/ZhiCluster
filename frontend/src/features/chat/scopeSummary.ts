import type { Folder, KnowledgeBase, Tag } from "../../lib/api";

function names(
  ids: string[],
  entities: { id: string; name: string }[],
  fallback: string,
) {
  const byId = new Map(entities.map((entity) => [entity.id, entity.name]));
  const known = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const missing = ids.length - known.length;
  if (missing) known.push(`${missing} 个已保存${fallback}`);
  return known.join("、");
}

export function scopeSummary({
  knowledgeBases,
  folders,
  tags,
  kbIds,
  folderIds,
  tagIds,
  includeDescendants,
}: {
  knowledgeBases: KnowledgeBase[];
  folders: Folder[];
  tags: Tag[];
  kbIds: string[];
  folderIds: string[];
  tagIds: string[];
  includeDescendants: boolean;
}) {
  if (!kbIds.length) return "选择知识库后提问";
  const parts = [`基于 ${names(kbIds, knowledgeBases, "知识库")}`];
  if (folderIds.length)
    parts.push(
      `文件夹：${names(folderIds, folders, "文件夹范围")}${includeDescendants ? "（含子文件夹）" : ""}`,
    );
  if (tagIds.length)
    parts.push(
      `标签：${names(tagIds, tags, "标签范围")}${tagIds.length > 1 ? "（同时匹配）" : ""}`,
    );
  return parts.join(" · ");
}
