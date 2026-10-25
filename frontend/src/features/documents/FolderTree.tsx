import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import type { Folder } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { ContextMenu, Menu, MenuItem } from "../../components/ui/menu";
import { folderRows, indexFolders } from "./folderNavigation";
export type FolderAction = "create" | "rename" | "move" | "trash" | "restore";
export function FolderTree({
  folders,
  selected,
  onSelect,
  onAction,
  onDrop,
  trash = false,
  active = true,
  mode = "tree",
  parentId = null,
  sort = "name",
}: {
  folders: Folder[];
  selected: string;
  onSelect: (id: string) => void;
  onAction: (action: FolderAction, folder?: Folder) => void;
  onDrop: (event: DragEvent, id: string | null) => void;
  trash?: boolean;
  active?: boolean;
  mode?: "tree" | "explorer";
  parentId?: string | null;
  sort?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const index = useMemo(() => indexFolders(folders, trash), [folders, trash]);
  const rows = useMemo(
    () =>
      mode === "explorer"
        ? [...(index.children.get(parentId) || [])]
            .sort((a, b) =>
              sort === "created" || sort === "updated"
                ? (sort === "updated"
                    ? b.updated_at || b.created_at || ""
                    : b.created_at || ""
                  ).localeCompare(
                    sort === "updated"
                      ? a.updated_at || a.created_at || ""
                      : a.created_at || "",
                  )
                : a.name.localeCompare(b.name, "zh-CN"),
            )
            .map((folder) => ({ folder, depth: 0 }))
        : folderRows(index, collapsed),
    [index, collapsed, mode, parentId, sort],
  );
  function folderMenu(f: Folder) {
    return (
      <>
        {trash ? (
          <MenuItem onSelect={() => onAction("restore", f)}>
            恢复文件夹
          </MenuItem>
        ) : (
          <>
            <MenuItem onSelect={() => onAction("create", f)}>
              新建子文件夹
            </MenuItem>
            <MenuItem onSelect={() => onAction("rename", f)}>重命名</MenuItem>
            <MenuItem onSelect={() => onAction("move", f)}>移动文件夹</MenuItem>
            <MenuItem danger onSelect={() => onAction("trash", f)}>
              移到回收站
            </MenuItem>
          </>
        )}
      </>
    );
  }
  const treeRows = rows.map(({ folder: f, depth }) => {
    const children = !!index.children.get(f.id)?.length;
    const closed = collapsed.has(f.id);
    return (
      <div key={f.id}>
        <ContextMenu
          active={active}
          trigger={
            <div
              draggable={!trash}
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-zhicluster-folder", f.id);
                e.stopPropagation();
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.stopPropagation();
                onDrop(e, f.id);
              }}
              className={`folder-row ${mode === "explorer" ? "explorer-folder-row" : ""} ${selected === f.id ? "selected" : ""}`}
              style={{ paddingLeft: depth * 14 + 4 }}
            >
              {mode === "tree" && (
                <button
                  className="tree-toggle"
                  aria-label={`${closed ? "展开" : "折叠"}${f.name}`}
                  aria-expanded={children ? !closed : undefined}
                  disabled={!children}
                  onClick={() =>
                    setCollapsed((s) => {
                      const n = new Set(s);
                      if (n.has(f.id)) n.delete(f.id);
                      else n.add(f.id);
                      return n;
                    })
                  }
                >
                  {children ? (
                    closed ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )
                  ) : (
                    <span />
                  )}
                </button>
              )}
              <button
                className="folder-name"
                aria-label={f.name}
                title={`${f.name}（第 ${depth + 1} 层）`}
                aria-current={selected === f.id ? "location" : undefined}
                onClick={() => onSelect(f.id)}
              >
                <span
                  className={
                    mode === "explorer" ? "explorer-folder-icon" : undefined
                  }
                >
                  <FolderIcon size={mode === "explorer" ? 29 : 15} />
                </span>
                {mode === "explorer" ? (
                  <span className="explorer-folder-info">
                    <strong>{f.name}</strong>
                    <small>
                      文件夹
                      {f.updated_at || f.created_at
                        ? ` · ${new Date((f.updated_at || f.created_at)!).toLocaleDateString("zh-CN")}更新`
                        : ""}
                    </small>
                  </span>
                ) : (
                  <span>{f.name}</span>
                )}
              </button>
              <Menu
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${f.name}文件夹菜单`}
                  >
                    <MoreHorizontal size={14} />
                  </Button>
                }
              >
                {folderMenu(f)}
              </Menu>
            </div>
          }
        >
          {folderMenu(f)}
        </ContextMenu>
      </div>
    );
  });
  return (
    <div
      className={`folder-tree ${mode === "explorer" ? "explorer-folders" : ""}`}
    >
      {mode === "tree" && (
        <div className="section-heading">
          <span>{trash ? "已删除文件夹" : "文件夹"}</span>
          {!trash && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="新建文件夹"
              onClick={() => onAction("create")}
            >
              <Plus size={14} />
            </Button>
          )}
        </div>
      )}
      {treeRows}
      {mode === "tree" && !index.visible.length && (
        <p className="tiny muted">
          {trash ? "没有已删除的文件夹" : "按主题建立文件夹，整理你的知识。"}
        </p>
      )}
    </div>
  );
}
