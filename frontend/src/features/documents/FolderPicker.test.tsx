import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Folder } from "../../lib/api";
import { FolderPicker } from "./FolderPicker";

afterEach(cleanup);
const folder = (
  id: string,
  name: string,
  parent_id: string | null = null,
): Folder => ({ id, name, parent_id, kb_id: "kb", version: 1 });

it("六千个目录只渲染有限选项，并可按叶目录名定位末部目标", async () => {
  const folders = Array.from({ length: 5999 }, (_, i) =>
    folder(`node-${i}`, `项目${i}`),
  );
  folders.push(folder("target", "唯一归档预算", "node-5998"));
  const changed = vi.fn();
  render(<FolderPicker folders={folders} value="" onValueChange={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "目标文件夹" }));
  expect(screen.getAllByRole("option")).toHaveLength(101);
  await user.keyboard("{Escape}");
  await user.type(
    screen.getByRole("textbox", { name: "搜索目标文件夹" }),
    "唯一归档预算",
  );
  await user.click(screen.getByRole("combobox", { name: "目标文件夹" }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await user.click(
    screen.getByRole("option", { name: "项目5998 / 唯一归档预算" }),
  );
  expect(changed).toHaveBeenCalledWith("target");
});

it("名称含路径分隔符时仍区分真实根目录和嵌套目录", async () => {
  const folders = [
    folder("literal", "研究 / 论文"),
    folder("parent", "研究"),
    folder("nested", "论文", "parent"),
  ];
  const changed = vi.fn();
  render(<FolderPicker folders={folders} value="" onValueChange={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "目标文件夹" }));
  expect(screen.getByRole("option", { name: '"研究 / 论文"' })).toBeVisible();
  await user.click(screen.getByRole("option", { name: "研究 / 论文" }));
  expect(changed).toHaveBeenCalledWith("nested");
});

it("按跨层路径搜索并排除自身子树，根目录始终可选", async () => {
  const folders = [
    folder("a", "部门"),
    folder("b", "项目", "a"),
    folder("c", "预算", "b"),
    folder("x", "待移动"),
    folder("y", "不应出现", "x"),
  ];
  const changed = vi.fn();
  const mounted = render(
    <FolderPicker
      folders={folders}
      excludedRoot="x"
      value=""
      onValueChange={changed}
    />,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "搜索目标文件夹" }),
    "部门 / 预算",
  );
  await user.click(screen.getByRole("combobox", { name: "目标文件夹" }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await user.click(screen.getByRole("option", { name: "部门 / 项目 / 预算" }));
  expect(changed).toHaveBeenCalledWith("c");
  mounted.rerender(
    <FolderPicker
      folders={folders}
      excludedRoot="x"
      value="c"
      onValueChange={changed}
    />,
  );
  await user.clear(screen.getByRole("textbox", { name: "搜索目标文件夹" }));
  await user.type(
    screen.getByRole("textbox", { name: "搜索目标文件夹" }),
    "不应出现",
  );
  await user.click(screen.getByRole("combobox", { name: "目标文件夹" }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  const root = screen.getByRole("option", { name: "知识库根目录" });
  expect(root).toBeVisible();
  await user.click(root);
  expect(changed).toHaveBeenLastCalledWith("");
});

it("在目录搜索框按Enter不会隐式提交外层移动表单", async () => {
  const submitted = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <form onSubmit={submitted}>
      <FolderPicker
        folders={[folder("target", "归档")]}
        value=""
        onValueChange={vi.fn()}
      />
      <button type="submit">保存移动</button>
    </form>,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "搜索目标文件夹" }),
    "归档{Enter}",
  );
  expect(submitted).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "保存移动" }));
  expect(submitted).toHaveBeenCalledOnce();
});
