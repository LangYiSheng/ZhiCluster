import { expect, it } from "vitest";
import type { Folder } from "../../lib/api";
import {
  folderDestinations,
  folderRows,
  indexFolders,
} from "./folderNavigation";

const folder = (
  id: string,
  parent_id: string | null = null,
  name = id,
): Folder => ({ id, parent_id, name, kb_id: "kb", version: 1 });

it("六千层合法目录完整遍历，不受递归栈或32层截断影响", () => {
  const folders = Array.from({ length: 6000 }, (_, i) =>
    folder(String(i), i ? String(i - 1) : null),
  );
  const index = indexFolders(folders);
  const rows = folderRows(index, new Set());
  expect(rows).toHaveLength(6000);
  expect(rows.at(-1)?.depth).toBe(5999);
  expect(folderRows(index, new Set(["0"])).map((row) => row.folder.id)).toEqual(
    ["0"],
  );
});

it("移动选项排除自身整棵子树，并用完整路径区分同名目录", () => {
  const folders = [
    folder("a", null, "研究"),
    folder("b", "a", "论文"),
    folder("c", "b", "附录"),
    folder("x", null, "项目"),
    folder("y", "x", "论文"),
  ];
  expect(folderDestinations(folders, "a")).toEqual([
    { value: "x", label: "项目" },
    { value: "y", label: "项目 / 论文" },
  ]);
  expect(
    folderDestinations(folders).find((option) => option.value === "b")?.label,
  ).toBe("研究 / 论文");
});

it("已删除目录按模式隔离，缺失父目录的回收项目仍可显示", () => {
  const folders = [
    folder("a"),
    { ...folder("b", "a"), deleted_at: "2026-10-24" },
  ];
  expect(
    folderRows(indexFolders(folders), new Set()).map((row) => row.folder.id),
  ).toEqual(["a"]);
  expect(
    folderRows(indexFolders(folders, true), new Set()).map(
      (row) => row.folder.id,
    ),
  ).toEqual(["b"]);
});
