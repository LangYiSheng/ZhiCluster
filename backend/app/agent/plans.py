"""Untrusted model output is validated before it becomes a reviewable plan."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateFolderParams(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    parent_id: str | None = None


class MoveParams(StrictModel):
    folder_id: str | None = None


class TagParams(StrictModel):
    mode: Literal["add", "remove", "set"] = "add"
    tag_ids: list[str] = Field(default_factory=list, max_length=30)
    new_tag_names: list[str] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def validate_names(self):
        if any(not name.strip() or len(name) > 80 for name in self.new_tag_names):
            raise ValueError("标签名称不能为空且不能超过 80 个字符")
        return self


class RenameParams(StrictModel):
    name: str = Field(min_length=1, max_length=240)


class EmptyParams(StrictModel):
    pass


class OperationBase(StrictModel):
    operation_id: str = Field(default_factory=lambda: str(uuid4()), min_length=1, max_length=64)
    target_ids: list[str] = Field(default_factory=list, max_length=500)
    description: str = Field(min_length=1, max_length=1000)
    dependencies: list[str] = Field(default_factory=list, max_length=100)
    enabled: bool = True
    reversible: Literal[True] = True


class CreateFolder(OperationBase):
    type: Literal["create_folder"] = "create_folder"
    params: CreateFolderParams


class MoveDocuments(OperationBase):
    type: Literal["move_documents"] = "move_documents"
    params: MoveParams


class UpdateDocumentTags(OperationBase):
    type: Literal["update_document_tags"] = "update_document_tags"
    params: TagParams


class RenameDocument(OperationBase):
    type: Literal["rename_document"] = "rename_document"
    params: RenameParams


class RenameFolder(OperationBase):
    type: Literal["rename_folder"] = "rename_folder"
    params: RenameParams


class TrashDocuments(OperationBase):
    type: Literal["trash_documents"] = "trash_documents"
    params: EmptyParams = Field(default_factory=EmptyParams)


Operation = Annotated[
    CreateFolder | MoveDocuments | UpdateDocumentTags | RenameDocument | RenameFolder | TrashDocuments,
    Field(discriminator="type"),
]


class PlanDraft(StrictModel):
    """Only this schema is requested from the planning model."""

    summary: str = Field(min_length=1, max_length=3000)
    operations: list[Operation] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_dependencies(self):
        seen: set[str] = set()
        enabled: set[str] = set()
        for operation in self.operations:
            if operation.operation_id in seen:
                raise ValueError("操作 ID 必须唯一")
            if not set(operation.dependencies).issubset(seen):
                raise ValueError("依赖必须指向前面的操作，不能引用不存在的操作或形成循环")
            if operation.enabled and not set(operation.dependencies).issubset(enabled):
                raise ValueError("启用的操作不能依赖已取消的操作")
            if operation.type == "create_folder":
                if operation.target_ids:
                    raise ValueError("新建文件夹不接受已有目标 ID")
            elif not operation.target_ids or len(set(operation.target_ids)) != len(operation.target_ids):
                raise ValueError("操作必须具有不重复的目标 ID")
            if operation.type in ("rename_document", "rename_folder") and len(operation.target_ids) != 1:
                raise ValueError("重命名操作必须具有一个目标")
            reference = getattr(operation.params, "folder_id", None)
            if operation.type == "create_folder":
                reference = operation.params.parent_id
            if reference and reference.startswith("ref:"):
                dependency = reference[4:]
                previous = next((op for op in self.operations if op.operation_id == dependency), None)
                if dependency not in operation.dependencies or not previous or previous.type != "create_folder":
                    raise ValueError("临时文件夹引用必须显式依赖前面的新建文件夹操作")
            seen.add(operation.operation_id)
            if operation.enabled:
                enabled.add(operation.operation_id)
        return self


class AgentPlanData(PlanDraft):
    plan_id: str = Field(default_factory=lambda: str(uuid4()))
    kb_id: str
    goal: str = Field(min_length=1, max_length=4000)
    expected_changes: int = 0
    risk_level: Literal["low", "high"] = "low"
    status: str = "pending_review"
    base_versions: dict[str, int] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def derive_impact(self):
        enabled = [op for op in self.operations if op.enabled]
        self.risk_level = "high" if any(op.type == "trash_documents" for op in enabled) else "low"
        self.expected_changes = len({target for op in enabled for target in op.target_ids}) + sum(
            op.type == "create_folder" for op in enabled
        )
        return self


class RunRequest(StrictModel):
    kb_id: str
    goal: str = Field(min_length=1, max_length=4000)


class PlanEdit(StrictModel):
    version: int = Field(ge=1)
    operations: list[Operation] = Field(min_length=1, max_length=100)
    summary: str | None = Field(default=None, max_length=3000)


class ApproveRequest(StrictModel):
    plan_version: int = Field(ge=1)
    confirm_high_risk: bool = False
