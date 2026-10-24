import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenu, Menu, MenuItem } from "./menu";
import { Dialog } from "./dialog";
import { FolderTree } from "../../features/documents/FolderTree";

afterEach(cleanup);

function openWithKeyboard(source: HTMLElement) {
  source.focus();
  fireEvent.keyDown(source, { key: "F10", shiftKey: true });
  // Browsers dispatch this event for Shift+F10; jsdom has no native menu.
  fireEvent.contextMenu(source, { clientX: 20, clientY: 20 });
}

it("右键菜单支持键盘逐项导航、Escape关闭并把焦点还给原控件", async () => {
  render(
    <ContextMenu trigger={<button>来源</button>}>
      <MenuItem onSelect={vi.fn()}>重命名</MenuItem>
      <MenuItem onSelect={vi.fn()}>移动</MenuItem>
    </ContextMenu>,
  );
  const source = screen.getByRole("button", { name: "来源" });
  openWithKeyboard(source);
  await waitFor(() =>
    expect(screen.getByRole("menuitem", { name: "重命名" })).toHaveFocus(),
  );
  const user = userEvent.setup();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "移动" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await waitFor(() => expect(source).toHaveFocus());
});

it.each(["context", "dropdown"])(
  "%s菜单打开编辑弹窗后保留输入框的明确初始焦点",
  async (kind) => {
    function Example() {
      const [editing, setEditing] = useState(false);
      const Root = kind === "context" ? ContextMenu : Menu;
      return (
        <>
          <Root trigger={<button>来源</button>}>
            <MenuItem onSelect={() => setEditing(true)}>重命名</MenuItem>
          </Root>
          <Dialog open={editing} onOpenChange={setEditing} title="编辑名称">
            <input aria-label="新名称" autoFocus />
          </Dialog>
        </>
      );
    }
    render(<Example />);
    const source = screen.getByRole("button", { name: "来源" });
    if (kind === "context") openWithKeyboard(source);
    else {
      source.focus();
      await userEvent.setup().keyboard("{ArrowDown}");
    }
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "新名称" })).toHaveFocus(),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  },
);

it("隐藏工作区关闭Portal菜单，返回时不自动重开", async () => {
  const view = (active: boolean) => (
    <ContextMenu active={active} trigger={<button>来源</button>}>
      <MenuItem onSelect={vi.fn()}>重命名</MenuItem>
    </ContextMenu>
  );
  const mounted = render(view(true));
  openWithKeyboard(screen.getByRole("button", { name: "来源" }));
  await screen.findByRole("menu");
  mounted.rerender(view(false));
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  mounted.rerender(view(true));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it.each(["context", "dropdown"])(
  "%s菜单点击外部会关闭且保留外部控件焦点",
  async (kind) => {
    const Root = kind === "context" ? ContextMenu : Menu;
    const clicked = vi.fn();
    render(
      <>
        <Root trigger={<button>来源</button>}>
          <MenuItem onSelect={vi.fn()}>重命名</MenuItem>
        </Root>
        <button onClick={clicked}>外部操作</button>
      </>,
    );
    const source = screen.getByRole("button", { name: "来源" });
    const user = userEvent.setup();
    if (kind === "context") openWithKeyboard(source);
    else {
      source.focus();
      await user.keyboard("{ArrowDown}");
    }
    await screen.findByRole("menu");
    const outside = screen.getByRole("button", { name: "外部操作" });
    await user.click(outside);
    expect(clicked).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(outside).toHaveFocus());
  },
);

it("真实文件夹树的右键菜单能以键盘选择正确目录操作", async () => {
  const folder = {
    id: "target",
    kb_id: "kb",
    parent_id: null,
    name: "研究目录",
    version: 1,
  };
  const action = vi.fn();
  render(
    <FolderTree
      folders={[folder]}
      selected=""
      onSelect={vi.fn()}
      onAction={action}
      onDrop={vi.fn()}
    />,
  );
  openWithKeyboard(screen.getByRole("button", { name: /^研究目录$/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "新建子文件夹" }),
    ).toHaveFocus(),
  );
  await userEvent.setup().keyboard("{ArrowDown}{Enter}");
  expect(action).toHaveBeenCalledWith("rename", folder);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
