"""Immutable organization authority and server-generated cleanup proposals."""

from collections import defaultdict

from app.agent.plans import OrganizationPolicy, PlanDraft
from app.core.errors import AppError

MODE_OPERATIONS = {
    "tags": {"update_document_tags", "delete_tags"},
    "folders": {"create_folder", "move_documents", "trash_empty_folders"},
}
MODE_OPERATIONS["both"] = MODE_OPERATIONS["tags"] | MODE_OPERATIONS["folders"]


def policy_from_source(mode, source, cleanup=True):
    parents = {folder["id"]: folder["parent_id"] for folder in source["folders"]}
    eligible = set()
    if cleanup and mode != "tags":
        if source.get("complete_scope"):
            eligible.update(parents)
        for doc in source["documents"]:
            current, seen = doc["folder_id"], set()
            while current in parents and current not in seen:
                seen.add(current)
                eligible.add(current)
                current = parents[current]
    return OrganizationPolicy(mode=mode, document_ids=[doc["id"] for doc in source["documents"]],
                              cleanup_folder_ids=sorted(eligible),
                              cleanup_scope="knowledge_base" if source.get("complete_scope") else "source_folders")


def validate_policy(data):
    policy = data.organization
    if policy is None:  # Already reviewed legacy plans keep their old authority.
        return
    scope = set(policy.document_ids)
    for op in data.operations:
        # Disabled operations cannot smuggle an out-of-mode change into a later edit.
        if op.type not in MODE_OPERATIONS[policy.mode]:
            raise AppError("organization_mode_violation", "方案包含所选整理模式之外的操作，请重新生成", 422)
        if op.type in {"move_documents", "update_document_tags"} and not set(op.target_ids) <= scope:
            raise AppError("organization_scope_violation", "方案不能修改未选择的文档", 422)
        if op.type == "trash_empty_folders" and not set(op.target_ids) <= set(policy.cleanup_folder_ids):
            raise AppError("organization_scope_violation", "只能清理所选文档原位置及其上级的空目录", 422)
        if op.type == "delete_tags" and any(
            not set(data.base_tag_links.get(identifier, [])) <= scope for identifier in op.target_ids
        ):
            raise AppError("organization_scope_violation", "标签仍关联未选择的文档，不能在本次整理中删除", 422)


def append_cleanup(draft: PlanDraft | None, source, policy: OrganizationPolicy) -> PlanDraft | None:
    """Offer only original directories that will actually become empty.

    Complete-library selections may also clear already-empty directories;
    partial selections never include unrelated structures.
    Execution rechecks the same fact against fresh rows under the namespace lock.
    """
    if not policy.cleanup_folder_ids:
        return draft
    parents = {folder["id"]: folder["parent_id"] for folder in source["folders"]}
    children = defaultdict(set)
    for folder_id, parent in parents.items():
        children[parent].add(folder_id)
    positions = dict(source.get("folder_documents", {}))
    if not positions:
        positions = {doc["id"]: doc["folder_id"] for doc in source["documents"]}
    operations = draft.operations if draft else []
    moves = []
    new_parents, protected = {}, set()
    for op in operations:
        if op.enabled and op.type == "create_folder":
            new_parents[f"ref:{op.operation_id}"] = op.params.parent_id
            current, seen = op.params.parent_id, set()
            while current and current not in seen:
                seen.add(current)
                if current in parents:
                    protected.add(current)
                    current = parents[current]
                else:
                    current = new_parents.get(current)
        if op.enabled and op.type == "move_documents":
            moves.append(op.operation_id)
            for identifier in op.target_ids:
                original = positions.get(identifier)
                if original != op.params.folder_id:
                    positions[identifier] = op.params.folder_id
    candidates = set(policy.cleanup_folder_ids) - protected
    already = {identifier for op in operations if op.type == "trash_empty_folders" for identifier in op.target_ids}
    cleaned, ordered = set(already), []
    all_parents = source.get("folder_parents", parents)

    def empty(identifier):
        descendants = {identifier}
        while True:
            expanded = descendants | {child for child, parent in all_parents.items() if parent in descendants}
            if expanded == descendants:
                break
            descendants = expanded
        return not descendants.intersection(positions.values())

    while candidates - cleaned:
        ready = sorted(identifier for identifier in candidates - cleaned
                       if empty(identifier) and children[identifier] <= cleaned)
        if not ready:
            break
        cleaned.update(ready)
        ordered.extend(ready)
    if not ordered:
        return draft
    used = {op.operation_id for op in operations}
    suffix = 1
    while f"cleanup-empty-{suffix}" in used:
        suffix += 1
    operation = {"type": "trash_empty_folders", "operation_id": f"cleanup-empty-{suffix}",
                 "target_ids": ordered, "params": {}, "dependencies": moves,
                 "description": ("清理全库空文件夹" if policy.cleanup_scope == "knowledge_base" else "清理所选文档原目录中的空文件夹")
                    + "（含整理后腾空的目录，移入回收站，可撤销）"}
    return PlanDraft(summary=draft.summary if draft else "清理整理范围内的空文件夹，文档位置不变", operations=[*operations, operation])
