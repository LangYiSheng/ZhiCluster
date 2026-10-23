import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Checkbox } from "../../components/ui/checkbox";
import { Select } from "../../components/ui/select";
import type { Folder, Operation, Tag } from "../../lib/api";
import { query } from "../../lib/api";
import type { OperationPreview } from "./api";
import { folderPath, operationDestination, operationLabels } from "./api";

function TagNamesInput({
  initial,
  disabled,
  onChange,
}: {
  initial: string[];
  disabled: boolean;
  onChange: (names: string[]) => void;
}) {
  const [text, setText] = useState(initial.join("，"));
  return (
    <input
      value={text}
      disabled={disabled}
      placeholder="用逗号分隔"
      onChange={(event) => {
        setText(event.target.value);
        onChange([
          ...new Set(
            event.target.value
              .split(/[,，]/)
              .map((name) => name.trim())
              .filter(Boolean),
          ),
        ]);
      }}
    />
  );
}

export function OperationEditor({
  operation,
  operations,
  preview,
  kbId,
  folders,
  tags,
  disabled,
  onChange,
}: {
  operation: Operation;
  operations: Operation[];
  preview?: OperationPreview;
  kbId: string;
  folders: Folder[];
  tags: Tag[];
  disabled: boolean;
  onChange: (next: Operation) => void;
}) {
  const op = operation;
  const enabled = op.enabled !== false;
  function patch(params: Record<string, unknown>) {
    onChange({ ...op, params: { ...op.params, ...params } });
  }
  function chooseFolder(key: "folder_id" | "parent_id", value: string) {
    const folderCreates = new Set(
      operations
        .filter((item) => item.type === "create_folder")
        .map((item) => item.operation_id),
    );
    const dependencies = op.dependencies.filter((id) => !folderCreates.has(id));
    if (value.startsWith("ref:")) dependencies.push(value.slice(4));
    onChange({
      ...op,
      params: { ...op.params, [key]: value || null },
      dependencies: [...new Set(dependencies)],
    });
  }
  const options = [
    { value: "", label: "未分类 / 根目录" },
    ...folders
      .filter((folder) => !folder.deleted_at)
      .map((folder) => ({
        value: folder.id,
        label: folderPath(folder.id, folders),
      })),
    ...operations
      .filter(
        (item) =>
          item.type === "create_folder" &&
          item.operation_id !== op.operation_id,
      )
      .map((item) => ({
        value: `ref:${item.operation_id}`,
        label: `新建：${operationDestination(item, folders, operations)}`,
      })),
  ];
  return (
    <article className={`review-operation${enabled ? "" : " is-disabled"}`}>
      <div className="review-operation-heading">
        <Checkbox
          aria-label={`选择操作：${op.description || operationLabels[op.type]}`}
          checked={enabled}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...op, enabled: event.target.checked })
          }
        />
        <strong>{operationLabels[op.type] || op.type}</strong>
        {op.type === "trash_documents" && (
          <span className="review-row-warning">移到回收站</span>
        )}
      </div>
      {op.type === "create_folder" || op.type === "move_documents" ? (
        <p className="review-move-preview">
          {op.type === "move_documents" ? "移动到" : "将创建"}
          <ArrowRight size={13} />
          <strong>{operationDestination(op, folders, operations)}</strong>
        </p>
      ) : op.type === "update_document_tags" ? (
        <p className="review-reason">
          {
            (
              { add: "添加", set: "替换", remove: "移除" } as Record<
                string,
                string
              >
            )[String(op.params.mode || "add")]
          }
          标签：
          {[
            ...((op.params.tag_ids as string[]) || []).map(
              (id) => tags.find((tag) => tag.id === id)?.name || "已失效标签",
            ),
            ...((op.params.new_tag_names as string[]) || []),
          ].join("、") || "无标签"}
        </p>
      ) : ["rename_document", "rename_folder"].includes(op.type) ? (
        <p className="review-move-preview">
          新名称
          <ArrowRight size={13} />
          <strong>{String(op.params.name || "")}</strong>
        </p>
      ) : (
        <p className="review-reason">{op.description}</p>
      )}
      {!!op.target_ids.length && (
        <div className="review-operation-targets">
          {preview?.targets?.length ? (
            preview.targets.map((target) => (
              <div key={target.id}>
                {target.available === false ? (
                  <span className="review-row-warning">
                    {target.name || "目标已不可用"}
                  </span>
                ) : target.kind === "document" ? (
                  <Link
                    to={`/document${query({ kb: kbId, document: target.id, mode: "read" })}`}
                  >
                    {target.name}
                  </Link>
                ) : (
                  <span>{target.name}</span>
                )}
                {target.folder_path && (
                  <small>当前位置：{target.folder_path}</small>
                )}
              </div>
            ))
          ) : (
            <span className="review-row-warning">
              目标信息暂不可用，请刷新方案后再审批。
            </span>
          )}
        </div>
      )}
      <details className="review-parameter-editor">
        <summary>调整参数</summary>
        <fieldset disabled={disabled || !enabled}>
          {["create_folder", "rename_document", "rename_folder"].includes(
            op.type,
          ) && (
            <label>
              名称
              <input
                value={String(op.params.name || "")}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
          )}
          {op.type === "create_folder" && (
            <label>
              父文件夹
              <Select
                aria-label={`父文件夹：${op.operation_id}`}
                value={String(op.params.parent_id || "")}
                onValueChange={(value) => chooseFolder("parent_id", value)}
                options={options}
              />
            </label>
          )}
          {op.type === "move_documents" && (
            <label>
              移动到
              <Select
                aria-label={`目标文件夹：${op.operation_id}`}
                value={String(op.params.folder_id || "")}
                onValueChange={(value) => chooseFolder("folder_id", value)}
                options={options}
              />
            </label>
          )}
          {op.type === "update_document_tags" && (
            <>
              <label>
                标签方式
                <Select
                  aria-label={`标签方式：${op.operation_id}`}
                  value={String(op.params.mode || "add")}
                  onValueChange={(value) => patch({ mode: value })}
                  options={[
                    { value: "add", label: "添加标签" },
                    { value: "set", label: "替换标签" },
                    { value: "remove", label: "移除标签" },
                  ]}
                />
              </label>
              <div className="review-tag-options">
                {tags.map((tag) => (
                  <label className="checkbox-label" key={tag.id}>
                    <Checkbox
                      checked={((op.params.tag_ids as string[]) || []).includes(
                        tag.id,
                      )}
                      onChange={(event) =>
                        patch({
                          tag_ids: event.target.checked
                            ? [
                                ...((op.params.tag_ids as string[]) || []),
                                tag.id,
                              ]
                            : ((op.params.tag_ids as string[]) || []).filter(
                                (id) => id !== tag.id,
                              ),
                        })
                      }
                    />
                    {tag.name}
                  </label>
                ))}
              </div>
              <label>
                新增标签
                <TagNamesInput
                  initial={(op.params.new_tag_names as string[]) || []}
                  disabled={disabled || !enabled}
                  onChange={(names) => patch({ new_tag_names: names })}
                />
              </label>
            </>
          )}
          {op.type === "trash_documents" && (
            <p className="review-note">只会移入回收站，执行前还需明确确认。</p>
          )}
        </fieldset>
      </details>
    </article>
  );
}
