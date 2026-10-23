import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ScopeSelector } from "./ScopeSelector";
import { scopeSummary } from "./scopeSummary";

const kb = { id: "kb", name: "资料库", description: "", version: 1 };
const folder = {
  id: "f",
  kb_id: kb.id,
  parent_id: null,
  name: "研究资料",
  version: 1,
};
const tag = { id: "t", name: "政策", color: "#333333", version: 1 };

function ScopeHost({ readOnly = false }: { readOnly?: boolean }) {
  const [kbIds, setKbIds] = useState([kb.id]);
  const [folderIds, setFolderIds] = useState<string[]>([folder.id]);
  const [tagIds, setTagIds] = useState<string[]>([tag.id]);
  return (
    <ScopeSelector
      knowledgeBases={[kb]}
      folders={[folder]}
      tags={[tag]}
      currentKb={kb}
      kbIds={kbIds}
      folderIds={folderIds}
      tagIds={tagIds}
      includeDescendants
      readOnly={readOnly}
      disabled={false}
      onKbChange={setKbIds}
      onFoldersChange={setFolderIds}
      onTagsChange={setTagIds}
      onIncludeDescendantsChange={vi.fn()}
    />
  );
}

afterEach(cleanup);

it("范围 Tabs 支持箭头、首尾导航，选中范围跨页保留，Esc回触发器", async () => {
  const user = userEvent.setup();
  render(<ScopeHost />);
  const trigger = screen.getByRole("button", { name: "调整问答范围" });
  await user.click(trigger);
  const kbs = screen.getByRole("tab", { name: /知识库/ });
  const folders = screen.getByRole("tab", { name: /文件夹/ });
  const tags = screen.getByRole("tab", { name: /标签/ });
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  kbs.focus();
  await user.keyboard("{ArrowRight}");
  expect(folders).toHaveFocus();
  expect(folders).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/文件夹/);
  expect(screen.getByRole("checkbox", { name: folder.name })).toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: folder.name }));
  folders.focus();
  await user.keyboard("{End}");
  expect(tags).toHaveFocus();
  expect(screen.getByRole("checkbox", { name: tag.name })).toBeChecked();
  await user.keyboard("{Home}{ArrowLeft}");
  expect(tags).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("checkbox", { name: folder.name })).not.toBeChecked();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(trigger).toHaveFocus());
});

it("已保存会话可以切换查看范围，不能修改KB、文件夹与标签", async () => {
  const user = userEvent.setup();
  render(<ScopeHost readOnly />);
  await user.click(screen.getByRole("button", { name: "调整问答范围" }));
  expect(screen.getByText(/当前对话的范围已固定/)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: kb.name })).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: /文件夹/ }));
  expect(screen.getByRole("checkbox", { name: folder.name })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: folder.name })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "包含子文件夹" })).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: /标签/ }));
  expect(screen.getByRole("checkbox", { name: tag.name })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: tag.name })).toBeDisabled();
});

it("范围摘要给出真实名称，无法解析的已保存范围不猜测名称或泄露ID", () => {
  expect(
    scopeSummary({
      knowledgeBases: [kb],
      folders: [folder],
      tags: [tag],
      kbIds: [kb.id],
      folderIds: [folder.id, "unknown"],
      tagIds: [tag.id],
      includeDescendants: true,
    }),
  ).toBe(
    "基于 资料库 · 文件夹：研究资料、1 个已保存文件夹范围（含子文件夹） · 标签：政策",
  );
});
