import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Checkbox } from "../../components/ui/checkbox";
import { Select } from "../../components/ui/select";
import type { Folder, Operation, Tag } from "../../lib/api";
import { query } from "../../lib/api";
import type { OperationPreview } from "./api";
import {
  folderPath,
  operationDestination,
  operationLabels,
  operationTagDocuments,
} from "./api";

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
  const deletingMetadata = ["delete_tags", "trash_empty_folders"].includes(
    op.type,
  );
  const affectedDocuments = operationTagDocuments(op, preview);
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
    { value: "", label: "知识库根目录" },
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
        {["trash_documents", "trash_empty_folders", "delete_tags"].includes(
          op.type,
        ) && <span className="review-row-warning">需额外确认</span>}
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
                {deletingMetadata && (
                  <Checkbox
                    aria-label={`删除目标：${target.name}`}
                    checked={op.target_ids.includes(target.id)}
                    disabled={disabled || !enabled}
                    onChange={(event) => {
                      const ids = event.target.checked
                        ? [...op.target_ids, target.id]
                        : op.target_ids.filter((id) => id !== target.id);
                      onChange(
                        ids.length
                          ? { ...op, target_ids: ids }
                          : { ...op, enabled: false },
                      );
                    }}
                  />
                )}
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
                  <small>
                    {target.kind === "tag"
                      ? `影响 ${target.usage_count ?? "未知"} 份文档`
                      : `当前位置：${target.folder_path}`}
                  </small>
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
      {op.type === "delete_tags" && (
        <div className="review-reason">
          <p>
            删除所选标签，并移除 {affectedDocuments.length}{" "}
            份文档上的关联。文档内容会保留，整次整理可撤销。
          </p>
          {!!affectedDocuments.length && (
            <details className="review-parameter-editor">
              <summary>查看受影响文档 · {affectedDocuments.length}</summary>
              <ul>
                {affectedDocuments.map((document) => (
                  <li key={document.id}>
                    {document.name}
                    {document.deleted ? "（回收站）" : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {op.type === "trash_empty_folders" && (
        <p className="review-note">
          仅将空文件夹移入回收站。执行时会再次检查，已有文档或子文件夹则整批停止。
        </p>
      )}
      {!deletingMetadata && (
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
                        checked={(
                          (op.params.tag_ids as string[]) || []
                        ).includes(tag.id)}
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
              <p className="review-note">
                只会移入回收站，执行前还需明确确认。
              </p>
            )}
          </fieldset>
        </details>
      )}
    </article>
  );
}
