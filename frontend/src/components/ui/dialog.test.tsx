import { useEffect, useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "./dialog";
import { ContextMenu, Menu, MenuItem } from "./menu";

afterEach(cleanup);

type Kind = "button" | "dropdown" | "context";

function NextPage() {
  const target = useRef<HTMLButtonElement>(null);
  useEffect(() => target.current?.focus(), []);
  return <button ref={target}>新页面目标</button>;
}

function Example({
  kind,
  afterSave,
  inputAutoFocus = true,
}: {
  kind: Kind;
  afterSave?: "remove" | "disable" | "hide" | "inert" | "css-hide" | "navigate";
  inputAutoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const Root = kind === "context" ? ContextMenu : Menu;
  const source = (
    <button
      disabled={saved && afterSave === "disable"}
      onClick={kind === "button" ? () => setOpen(true) : undefined}
    >
      来源
    </button>
  );
  return (
    <>
      <section
        data-focus-return-scope
        tabIndex={-1}
        aria-label="资料区域"
        hidden={saved && afterSave === "hide"}
        inert={saved && afterSave === "inert"}
        style={
          saved && afterSave === "css-hide" ? { display: "none" } : undefined
        }
      >
        {!(saved && afterSave === "remove") &&
          (kind === "button" ? (
            source
          ) : (
            <Root trigger={kind === "context" ? <div>{source}</div> : source}>
              <MenuItem onSelect={() => setOpen(true)}>编辑</MenuItem>
            </Root>
          ))}
      </section>
      <Dialog open={open} onOpenChange={setOpen} title="编辑资料">
        <input aria-label="名称" autoFocus={inputAutoFocus} />
        <button
          onClick={() => {
            setSaved(true);
            setOpen(false);
          }}
        >
          保存
        </button>
      </Dialog>
      {saved && afterSave === "navigate" && <NextPage />}
    </>
  );
}

async function openExample(kind: Kind) {
  const user = userEvent.setup();
  const source = screen.getByRole("button", { name: "来源" });
  source.focus();
  if (kind === "button") await user.click(source);
  else {
    if (kind === "context") {
      fireEvent.keyDown(source, { key: "F10", shiftKey: true });
      fireEvent.contextMenu(source);
    } else await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    await user.keyboard("{Enter}");
  }
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  return { user, source };
}

it.each<Kind>(["button", "dropdown", "context"])(
  "%s打开受控弹窗，Escape关闭后回到实际来源",
  async (kind) => {
    render(<Example kind={kind} />);
    const { user, source } = await openExample(kind);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(source).toHaveFocus());
  },
);

it.each(["dropdown", "context"] as const)(
  "%s打开没有输入框首焦的确认弹窗，关闭仍返回菜单来源",
  async (kind) => {
    render(<Example kind={kind} inputAutoFocus={false} />);
    const source = screen.getByRole("button", { name: "来源" });
    const user = userEvent.setup();
    source.focus();
    if (kind === "context") {
      fireEvent.keyDown(source, { key: "F10", shiftKey: true });
      fireEvent.contextMenu(source);
    } else await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(source).toHaveFocus());
  },
);

it.each([
  ["context", "remove"],
  ["dropdown", "disable"],
] as const)("%s来源在保存后%s时回到同一资料区域", async (kind, afterSave) => {
  render(<Example kind={kind} afterSave={afterSave} />);
  const { user } = await openExample(kind);
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "资料区域" })).toHaveFocus(),
  );
});

it.each(["hide", "inert", "css-hide"] as const)(
  "来源所在区域%s时，不将焦点移回不可用内容",
  async (afterSave) => {
    render(<Example kind="button" afterSave={afterSave} />);
    const { user, source } = await openExample("button");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // Let the primitive's deferred close autofocus run before checking visibility.
    await waitFor(() => expect(document.body).toHaveFocus());
    expect(source).not.toHaveFocus();
  },
);

it("关闭弹窗时保留新页面主动设置的焦点", async () => {
  render(<Example kind="button" afterSave="navigate" />);
  const { user } = await openExample("button");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "新页面目标" })).toHaveFocus(),
  );
});

it("同一个受控弹窗重新打开时使用本次来源", async () => {
  function Reopen() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>甲来源</button>
        <button onClick={() => setOpen(true)}>乙来源</button>
        <Dialog open={open} onOpenChange={setOpen} title="编辑">
          <input aria-label="名称" autoFocus />
        </Dialog>
      </>
    );
  }
  render(<Reopen />);
  const user = userEvent.setup();
  for (const name of ["甲来源", "乙来源"]) {
    const source = screen.getByRole("button", { name });
    await user.click(source);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(source).toHaveFocus());
  }
});

it.each([false, true])(
  "嵌套弹窗逐层关闭，来源被删除=%s时回到对应层",
  async (removeSource) => {
    function Nested() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      const [sourceAlive, setSourceAlive] = useState(true);
      return (
        <>
          <button onClick={() => setOuter(true)}>页面来源</button>
          <Dialog open={outer} onOpenChange={setOuter} title="外层">
            {sourceAlive && (
              <button autoFocus onClick={() => setInner(true)}>
                内层来源
              </button>
            )}
            <Dialog open={inner} onOpenChange={setInner} title="内层">
              <input aria-label="内层名称" autoFocus />
              <button
                onClick={() => {
                  setSourceAlive(false);
                  setInner(false);
                }}
              >
                保存内层
              </button>
            </Dialog>
          </Dialog>
        </>
      );
    }
    render(<Nested />);
    const user = userEvent.setup();
    const pageSource = screen.getByRole("button", { name: "页面来源" });
    await user.click(pageSource);
    const innerSource = screen.getByRole("button", { name: "内层来源" });
    await user.click(innerSource);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    if (removeSource) {
      await user.click(screen.getByRole("button", { name: "保存内层" }));
      await waitFor(() =>
        expect(screen.getByRole("dialog", { name: "外层" })).toHaveFocus(),
      );
    } else {
      await user.keyboard("{Escape}");
      await waitFor(() => expect(innerSource).toHaveFocus());
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(pageSource).toHaveFocus());
  },
);
