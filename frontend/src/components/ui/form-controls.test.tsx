import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./checkbox";
import { Radio } from "./radio";
import { Select } from "./select";

afterEach(cleanup);

it("自绘下拉支持键盘跳过禁用项、确认选择与 Escape 返回触发按钮", async () => {
  function Example() {
    const [value, setValue] = useState("first");
    return (
      <>
        <label htmlFor="choice">显示模式</label>
        <Select
          id="choice"
          value={value}
          onValueChange={setValue}
          options={[
            { value: "first", label: "浅色" },
            { value: "disabled", label: "不可选", disabled: true },
            { value: "last", label: "深色" },
          ]}
        />
      </>
    );
  }
  render(<Example />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "显示模式" });
  trigger.focus();
  await user.keyboard("{Enter}{ArrowDown}{Enter}");
  expect(trigger).toHaveTextContent("深色");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.keyboard("{Enter}{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("无文件夹选项保留空字符串，表单提交使用原始值并继承 fieldset 禁用", async () => {
  function Example() {
    const [value, setValue] = useState("folder");
    return (
      <form aria-label="移动文件">
        <Select
          aria-label="目标文件夹"
          name="folder"
          value={value}
          onValueChange={setValue}
          options={[
            { value: "", label: "未分类" },
            { value: "folder", label: "研究" },
          ]}
        />
        <fieldset disabled>
          <Select
            aria-label="锁定的选择"
            value="folder"
            onValueChange={vi.fn()}
            options={[{ value: "folder", label: "研究" }]}
          />
        </fieldset>
      </form>
    );
  }
  render(<Example />);
  const user = userEvent.setup();
  const form = screen.getByRole("form") as HTMLFormElement;
  expect(new FormData(form).get("folder")).toBe("folder");
  await user.click(screen.getByRole("combobox", { name: "目标文件夹" }));
  await user.click(screen.getByRole("option", { name: "未分类" }));
  expect(
    screen.getByRole("combobox", { name: "目标文件夹" }),
  ).toHaveTextContent("未分类");
  expect(new FormData(form).get("folder")).toBe("");
  const disabled = screen.getByRole("combobox", { name: "锁定的选择" });
  expect(disabled).toBeDisabled();
  await user.click(disabled);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("自绘多选保留混合状态和空格切换，单选保留方向键选择", async () => {
  function Example() {
    const [checked, setChecked] = useState(false);
    const [mixed, setMixed] = useState(true);
    return (
      <>
        <label>
          <Checkbox
            checked={checked}
            indeterminate={mixed}
            onChange={(event) => {
              setMixed(false);
              setChecked(event.target.checked);
            }}
          />
          选择文档
        </label>
        <label>
          <Radio name="mode" value="light" defaultChecked />
          浅色
        </label>
        <label>
          <Radio name="mode" value="dark" />
          深色
        </label>
      </>
    );
  }
  render(<Example />);
  const user = userEvent.setup();
  const checkbox = screen.getByRole("checkbox");
  expect(checkbox).toBePartiallyChecked();
  checkbox.focus();
  await user.keyboard(" ");
  expect(checkbox).toBeChecked();
  expect(checkbox).not.toBePartiallyChecked();
  screen.getByRole("radio", { name: "浅色" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "深色" })).toHaveFocus();
});
