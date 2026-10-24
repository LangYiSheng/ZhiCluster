import type { Folder } from "../../lib/api";

function folderSegment(name: string) {
  return /[/"\\]/.test(name) ? JSON.stringify(name) : name;
}

export function folderPathLabel(
  folders: Folder[] | Map<string, Folder>,
  id: string,
) {
  const byId =
    folders instanceof Map
      ? folders
      : new Map(folders.map((folder) => [folder.id, folder]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: Folder | undefined = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.push(folderSegment(current.name));
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return parts.reverse().join(" / ");
}

export function indexFolders(folders: Folder[], trash = false) {
  const visible = folders.filter((folder) =>
    trash ? !!folder.deleted_at : !folder.deleted_at,
  );
  const ids = new Set(visible.map((folder) => folder.id));
  const children = new Map<string | null, Folder[]>();
  for (const folder of visible) {
    const parent =
      folder.parent_id && ids.has(folder.parent_id) ? folder.parent_id : null;
    const siblings = children.get(parent) || [];
    siblings.push(folder);
    children.set(parent, siblings);
  }
  return { visible, children };
}

export function folderRows(
  index: ReturnType<typeof indexFolders>,
  collapsed: ReadonlySet<string>,
) {
  const result: { folder: Folder; depth: number }[] = [];
  const stack = (index.children.get(null) || [])
    .map((folder) => ({ folder, depth: 0 }))
    .reverse();
  const seen = new Set<string>();
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.folder.id)) continue;
    seen.add(row.folder.id);
    result.push(row);
    if (!collapsed.has(row.folder.id)) {
      const children = index.children.get(row.folder.id) || [];
      for (let i = children.length - 1; i >= 0; i--)
        stack.push({ folder: children[i], depth: row.depth + 1 });
    }
  }
  return result;
}

export function folderDestinations(folders: Folder[], excludedRoot?: string) {
  const index = indexFolders(folders);
  const result: { value: string; label: string }[] = [];
  const stack = (index.children.get(null) || [])
    .map((folder) => ({ folder, path: "" }))
    .reverse();
  const seen = new Set<string>();
  while (stack.length) {
    const { folder, path } = stack.pop()!;
    if (folder.id === excludedRoot || seen.has(folder.id)) continue;
    seen.add(folder.id);
    const segment = folderSegment(folder.name);
    const label = path ? `${path} / ${segment}` : segment;
    result.push({ value: folder.id, label });
    const children = index.children.get(folder.id) || [];
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ folder: children[i], path: label });
  }
  return result;
}
