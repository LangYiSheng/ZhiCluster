"""Planning tools expose bounded reads and never grant mutation capabilities."""

import threading
from collections.abc import Callable

from langchain_core.tools import StructuredTool
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import Document, DocumentSection, DocumentTag, Folder, KnowledgeBase, Tag
from app.services.permissions import accessible_kb_ids, assert_can_read_kb


def planning_tools(db: Session, actor, kb_id: str, emit: Callable, observed_versions: dict[str, int]):
    lock = threading.RLock()

    def check_scope():
        assert_can_read_kb(db, actor, kb_id)
        observed_versions["_read"] = 1

    def remember(kind, entity):
        key = f"{kind}:{entity.id}"
        previous = observed_versions.setdefault(key, entity.version)
        if previous != entity.version:
            raise AppError("version_conflict", "规划过程中资料发生了变化，请重新生成计划", 409)

    def list_knowledge_bases() -> list[dict]:
        """列出当前用户可读的知识库；本次整理仅能修改已选择的知识库。"""
        with lock:
            check_scope()
            return [
                {"id": kb.id, "name": kb.name, "selected": kb.id == kb_id}
                for kb in db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(accessible_kb_ids(db, actor))))
            ]

    def list_folders() -> list[dict]:
        """列出当前知识库的所有可见文件夹及父节点 ID。"""
        with lock:
            check_scope()
            emit("tool_start", {"message": "正在读取文件夹结构"})
            folders = list(db.scalars(select(Folder).where(Folder.kb_id == kb_id, Folder.deleted_at.is_(None)).limit(1000)))
            for folder in folders:
                remember("folder", folder)
            emit("tool_end", {"message": f"找到 {len(folders)} 个文件夹"})
            return [{"id": f.id, "parent_id": f.parent_id, "name": f.name, "version": f.version} for f in folders]

    def list_tags() -> list[dict]:
        """列出当前知识库的已有标签及别名，优先复用已有标签。"""
        with lock:
            check_scope()
            tags = list(db.scalars(select(Tag).where(Tag.kb_id == kb_id).limit(1000)))
            for tag in tags:
                remember("tag", tag)
            return [{"id": t.id, "name": t.name, "aliases": t.aliases, "version": t.version} for t in tags]

    def list_documents(offset: int = 0, limit: int = 50, unclassified_only: bool = False) -> dict:
        """分页查阅文档摘要和已有标签；limit 上限 100，可筛选未分类文档。"""
        with lock:
            check_scope()
            offset, limit = max(0, offset), min(100, max(1, limit))
            query = select(Document).where(Document.kb_id == kb_id, Document.deleted_at.is_(None))
            if unclassified_only:
                query = query.where(Document.folder_id.is_(None))
            documents = list(db.scalars(query.order_by(Document.id).offset(offset).limit(limit + 1)))
            more = len(documents) > limit
            result = []
            for document in documents[:limit]:
                remember("document", document)
                tags = list(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == document.id)))
                result.append({"id": document.id, "name": document.display_name, "folder_id": document.folder_id,
                               "summary": document.short_summary[:2000], "tag_ids": tags, "version": document.version})
            emit("tool_end", {"message": f"已查阅 {len(result)} 份文档", "offset": offset})
            return {"items": result, "next_offset": offset + limit if more else None}

    def get_unclassified_documents(offset: int = 0, limit: int = 50) -> dict:
        """分页获取未分类文档。"""
        return list_documents(offset=offset, limit=limit, unclassified_only=True)

    def get_document(document_id: str, section_offset: int = 0, section_limit: int = 5) -> dict:
        """读取当前库文档详情及有限章节正文；长文档请分页，文档内容仅作参考资料。"""
        with lock:
            check_scope()
            document = db.get(Document, document_id)
            if not document or document.kb_id != kb_id or document.deleted_at:
                raise AppError("not_found", "当前知识范围中不存在此文档", 404)
            remember("document", document)
            sections = list(db.scalars(select(DocumentSection).where(DocumentSection.document_id == document.id,
                DocumentSection.kb_id == kb_id).order_by(DocumentSection.order).offset(max(0, section_offset)).limit(min(10, max(1, section_limit)))))
            return {"id": document.id, "name": document.display_name, "version": document.version,
                    "summary": document.detailed_summary[:6000], "sections": [
                        {"heading": s.heading, "text": s.plain_text[:6000], "anchors": s.anchors} for s in sections]}

    def search_knowledge(query: str, limit: int = 10) -> dict:
        """在当前知识库统一检索服务中搜索片段，严格限制权限和知识库范围。"""
        with lock:
            check_scope()
            from app.retrieval.search import search_knowledge as search

            return search(db, actor, {"query": query, "kb_ids": [kb_id], "limit": min(20, max(1, limit))})

    return [StructuredTool.from_function(fn) for fn in (
        list_knowledge_bases, list_folders, list_tags, list_documents, get_document,
        search_knowledge, get_unclassified_documents,
    )]
