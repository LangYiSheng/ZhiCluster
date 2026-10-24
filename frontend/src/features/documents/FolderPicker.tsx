import { useMemo, useState } from "react";
import type { Folder } from "../../lib/api";
import { Select } from "../../components/ui/select";
import { folderPathLabel, folderRows, indexFolders } from "./folderNavigation";

const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase();
const MAX_VISIBLE = 100;

export function FolderPicker({
  folders,
  excludedRoot,
  value,
  onValueChange,
}: {
  folders: Folder[];
  excludedRoot?: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const index = useMemo(() => indexFolders(folders), [folders]);
  const rows = useMemo(
    () =>
      folderRows(index, new Set(excludedRoot ? [excludedRoot] : [])).filter(
        (row) => row.folder.id !== excludedRoot,
      ),
    [index, excludedRoot],
  );
  const choices = useMemo(() => {
    const terms = normalize(search)
      .split(/[\s/]+/)
      .filter(Boolean);
    const matches = new Map<string, boolean[]>();
    const chosen = new Set<string>();
    let count = 0;
    for (const { folder } of rows) {
      const inherited = matches.get(folder.parent_id || "") || [];
      const name = normalize(folder.name);
      const flags = terms.map((term, i) => inherited[i] || name.includes(term));
      matches.set(folder.id, flags);
      if (flags.every(Boolean)) {
        count++;
        if (chosen.size < MAX_VISIBLE) chosen.add(folder.id);
      }
    }
    // Keep the selected target named while searching. Build complete paths only
    // for the bounded set of displayed options, rather than the whole tree.
    if (rows.some(({ folder }) => folder.id === value)) chosen.add(value);
    const byId = new Map(index.visible.map((folder) => [folder.id, folder]));
    return {
      count,
      options: [...chosen].map((id) => ({
        value: id,
        label: folderPathLabel(byId, id),
      })),
    };
  }, [rows, index, search, value]);
  return (
    <div className="folder-destination-picker">
      <span>目标文件夹</span>
      <input
        aria-label="搜索目标文件夹"
        placeholder="输入名称或路径查找目录"
        value={search}
        maxLength={200}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Select
        aria-label="目标文件夹"
        value={value}
        onValueChange={onValueChange}
        options={[{ value: "", label: "根目录 / 未分类" }, ...choices.options]}
      />
      {choices.count > MAX_VISIBLE && (
        <p className="tiny muted">
          找到 {choices.count} 个目录，显示前 {MAX_VISIBLE}{" "}
          个；输入更多名称可缩小范围。
        </p>
      )}
      {!!search && !choices.count && (
        <p className="tiny muted" role="status">
          没有匹配的目录，可调整名称或选择根目录。
        </p>
      )}
    </div>
  );
}
