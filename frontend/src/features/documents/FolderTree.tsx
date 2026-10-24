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
import { Menu, MenuItem } from "../../components/ui/menu";
import { folderRows, indexFolders } from "./folderNavigation";
export type FolderAction = "create" | "rename" | "move" | "trash" | "restore";
export function FolderTree({
  folders,
  selected,
  onSelect,
  onAction,
  onDrop,
  trash = false,
}: {
  folders: Folder[];
  selected: string;
  onSelect: (id: string) => void;
  onAction: (action: FolderAction, folder?: Folder) => void;
  onDrop: (event: DragEvent, id: string | null) => void;
  trash?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [context, setContext] = useState<{
    folder: Folder;
    x: number;
    y: number;
  } | null>(null);
  const index = useMemo(() => indexFolders(folders, trash), [folders, trash]);
  const rows = useMemo(() => folderRows(index, collapsed), [index, collapsed]);
  const treeRows = rows.map(({ folder: f, depth }) => {
    const children = !!index.children.get(f.id)?.length;
    const closed = collapsed.has(f.id);
    return (
      <div key={f.id}>
        <div
          onContextMenu={(e) => {
            e.preventDefault();
            setContext({
              folder: f,
              x: Math.min(e.clientX, window.innerWidth - 200),
              y: Math.min(e.clientY, window.innerHeight - 200),
            });
          }}
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
          className={`folder-row ${selected === f.id ? "selected" : ""}`}
          style={{ paddingLeft: depth * 14 + 4 }}
        >
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
          <button
            className="folder-name"
            title={`${f.name}（第 ${depth + 1} 层）`}
            aria-current={selected === f.id ? "location" : undefined}
            onClick={() => onSelect(f.id)}
          >
            <FolderIcon size={15} />
            <span>{f.name}</span>
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
            {trash ? (
              <MenuItem onSelect={() => onAction("restore", f)}>
                恢复文件夹
              </MenuItem>
            ) : (
              <>
                <MenuItem onSelect={() => onAction("create", f)}>
                  新建子文件夹
                </MenuItem>
                <MenuItem onSelect={() => onAction("rename", f)}>
                  重命名
                </MenuItem>
                <MenuItem onSelect={() => onAction("move", f)}>
                  移动文件夹
                </MenuItem>
                <MenuItem danger onSelect={() => onAction("trash", f)}>
                  移到回收站
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
    );
  });
  return (
    <div className="folder-tree">
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
      {treeRows}
      {!index.visible.length && (
        <p className="tiny muted">
          {trash ? "没有已删除的文件夹" : "按主题建立文件夹，整理你的知识。"}
        </p>
      )}
      {context && (
        <div
          className="context-backdrop"
          onClick={() => setContext(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContext(null);
          }}
        >
          <div
            className="context-menu"
            role="menu"
            style={{ left: context.x, top: context.y }}
          >
            {(trash
              ? (["restore"] as const)
              : (["create", "rename", "move", "trash"] as const)
            ).map((action) => (
              <button
                role="menuitem"
                key={action}
                className={action === "trash" ? "danger" : ""}
                onClick={() => onAction(action, context.folder)}
              >
                {
                  {
                    create: "新建子文件夹",
                    rename: "重命名",
                    move: "移动文件夹",
                    trash: "移到回收站",
                    restore: "恢复文件夹",
                  }[action]
                }
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
