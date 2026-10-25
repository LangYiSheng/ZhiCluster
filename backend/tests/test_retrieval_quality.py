"""Deterministic compound-question and isolation checks without model calls."""

from hashlib import sha256

import pytest
from sqlalchemy import delete, event, select

from app.ai.gateway import ProviderError
from app.core.config import Settings
from app.db.models import (
    ChunkEmbedding,
    Document,
    DocumentChunk,
    DocumentSection,
    EmbeddingProfile,
    Folder,
    KnowledgeBase,
    KnowledgeBaseMember,
    utcnow,
)
from app.retrieval.ranking import document_purpose_weight
from app.retrieval.search import search_knowledge
from app.retrieval.terms import plan_query, semantic_queries
from app.services.permissions import get_actor


def document(db, kb, name, passages, *, folder_id=None, deleted_at=None):
    actor = get_actor(db)
    digest = sha256((kb.id + name).encode()).hexdigest()
    doc = Document(kb_id=kb.id, owner_id=actor.id, display_name=name, original_filename=name,
                   ext="txt", mime_type="text/plain", sha256=digest, storage_key=digest,
                   size_bytes=100, parse_status="ready", index_status="ready", folder_id=folder_id,
                   deleted_at=deleted_at)
    db.add(doc)
    db.flush()
    for index, content in enumerate(passages):
        section = DocumentSection(kb_id=kb.id, document_id=doc.id, plain_text=content,
                                  order=index, anchors={"paragraph": index + 1})
        db.add(section)
        db.flush()
        db.add(DocumentChunk(kb_id=kb.id, document_id=doc.id, section_id=section.id,
                             chunk_index=index, content=content, token_count=len(content),
                             anchors=section.anchors))
    db.flush()
    return doc


def test_compound_question_keeps_final_topic_and_filters_conversational_fillers():
    question = "请问我们研究中心的申请政策是怎么执行的，以及计算学部今年的具体名额是多少？"
    plan = plan_query(question)
    assert "名额" in plan.terms
    assert "计算" in plan.terms and "学部" in plan.terms
    assert "怎么" not in plan.terms and "我们" not in plan.terms
    long = plan_query("研究材料" * 60 + "，最终费用多少？")
    assert "最终费用" in long.terms
    assert len(long.terms) <= 48


def test_english_question_filters_fillers_without_losing_literal_only_queries():
    plan = plan_query("How can I measure chlorophyll fluorescence in leaves?")
    assert {"measure", "chlorophyll", "fluorescence", "leaves"} <= set(plan.terms)
    assert not {"how", "can", "i", "in"} & set(plan.terms)
    assert plan_query("is").terms == ("is",)
    assert plan_query("the who").terms == ("the who",)


def test_english_fillers_do_not_crowd_evidence_out_of_candidate_pool(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        for index in range(170):
            document(db, kb, f"note-{index}.txt", ["How can I measure a simple property in leaves? This is a general note."])
        target = document(db, kb, "photosynthesis.txt", ["Chlorophyll fluorescence quantifies photosynthetic yield in leaves."])
        result = search_knowledge(db, get_actor(db), {
            "query": "How can I measure chlorophyll fluorescence in leaves?", "mode": "keyword", "limit": 10,
        }, Settings(_env_file=None))
        assert result["items"][0]["document_id"] == target.id


def test_multiple_folder_scopes_expand_each_kb_once_and_preserve_descendant_filter(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        roots, direct, nested = [], set(), set()
        for index in range(10):
            root = Folder(kb_id=kb.id, name=f"root-{index}")
            db.add(root)
            db.flush()
            child = Folder(kb_id=kb.id, parent_id=root.id, name="child")
            db.add(child)
            db.flush()
            roots.append(root.id)
            direct.add(document(db, kb, f"direct-{index}.txt", ["范围检索证据"], folder_id=root.id).id)
            nested.add(document(db, kb, f"nested-{index}.txt", ["范围检索证据"], folder_id=child.id).id)
        document(db, kb, "outside.txt", ["范围检索证据"])
        folder_reads = []

        def count_folder_reads(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.lstrip().startswith("SELECT folders."):
                folder_reads.append(statement)

        event.listen(db.bind, "before_cursor_execute", count_folder_reads)
        try:
            request = {"query": "范围检索证据", "folder_ids": roots, "mode": "keyword", "limit": 30}
            result = search_knowledge(db, get_actor(db), request, Settings(_env_file=None))
            assert {item["document_id"] for item in result["items"]} == direct | nested
            assert len(folder_reads) == 4  # Root validation + tree read, before and after ranking.
            folder_reads.clear()
            result = search_knowledge(db, get_actor(db), {**request, "include_descendants": False}, Settings(_env_file=None))
            assert {item["document_id"] for item in result["items"]} == direct
            assert len(folder_reads) == 2
        finally:
            event.remove(db.bind, "before_cursor_execute", count_folder_reads)


def test_compound_semantic_queries_are_one_bounded_batch(factory, monkeypatch):
    question = "研究中心申请政策怎么执行？计算学部今年多少名额？"
    assert semantic_queries("索引故障排查") == ["索引故障排查"]
    calls = []

    class Gateway:
        embeddings_configured = True
        profile_fingerprint = "batch-profile"

        def __init__(self, _settings):
            pass

        def embed(self, texts):
            calls.append(texts)
            return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        target = document(db, kb, "计划说明.txt", ["研究中心申请政策采用综合评价。计算学部今年分配名额 28 人。"])
        profile = EmbeddingProfile(fingerprint="batch-profile", model_name="fake", dimension=2)
        db.add(profile)
        db.flush()
        chunk = db.scalar(select(DocumentChunk).where(DocumentChunk.document_id == target.id))
        db.add(ChunkEmbedding(kb_id=kb.id, chunk_id=chunk.id, profile_id=profile.id, embedding=[1.0, 0.0]))
        db.flush()
        result = search_knowledge(db, get_actor(db), {"query": question}, Settings())
        assert calls == [[question, "研究中心申请政策怎么执行", "计算学部今年多少名额"]]
        assert result["items"][0]["document_id"] == target.id


def test_body_evidence_and_second_topic_outrank_title_only_forms(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        forms = document(db, kb, "研究中心申请政策计算学部名额申请表.txt", ["姓名：____，性别：____，申请人签名。"] * 80)
        policy = document(db, kb, "年度实施细则.txt", ["研究中心申请政策要求公开考核，所有申请人按综合成绩排序。"])
        quota = document(db, kb, "学部指标公告.txt", ["计算学部今年分配名额为 28 人，其中联合培养名额为 4 人。"])
        found = search_knowledge(db, get_actor(db), {"query": "研究中心的申请政策是怎么执行的，计算学部今年有多少名额？", "limit": 4, "mode": "keyword"}, Settings())
        ids = [hit["document_id"] for hit in found["items"]]
        assert set(ids[:2]) == {policy.id, quota.id}
        assert ids.count(forms.id) <= 2
        assert found["items"][0]["anchors"] == {"paragraph": 1}


def test_diversity_retains_complementary_passages_and_pagination(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        first = document(db, kb, "索引操作指南.txt", ["索引故障排查：首先检查数据库连接和访问权限。"] * 20 + ["索引故障排查：重建索引后检查向量维度。"])
        second = document(db, kb, "索引故障处理.txt", ["索引故障恢复时应读取任务错误，确认文件解析已经完成。"])
        request = {"query": "索引故障排查与恢复", "mode": "keyword", "limit": 6}
        all_hits = search_knowledge(db, get_actor(db), request, Settings())["items"]
        assert {hit["document_id"] for hit in all_hits[:3]} == {first.id, second.id}
        page = search_knowledge(db, get_actor(db), {**request, "offset": 2, "limit": 2}, Settings())["items"]
        assert [hit["chunk_id"] for hit in page] == [hit["chunk_id"] for hit in all_hits[2:4]]


@pytest.mark.parametrize("query", ["100%_complete", r"folder\literal", "C++", "_", "%"])
def test_literal_symbols_do_not_become_sql_wildcards(factory, query):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        target = document(db, kb, "literal.txt", [f"Literal marker {query} must match exactly."])
        document(db, kb, "unrelated.txt", ["Completely unrelated ordinary content."])
        result = search_knowledge(db, get_actor(db), {"query": query, "mode": "keyword"}, Settings())
        assert [hit["document_id"] for hit in result["items"]] == [target.id]


def test_vector_failure_preserves_keyword_evidence_and_progress(factory, monkeypatch):
    class Gateway:
        embeddings_configured = True
        profile_fingerprint = "active-profile"

        def __init__(self, _settings):
            pass

        def embed(self, _texts):
            raise ProviderError("测试向量服务暂不可用")

    monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        target = document(db, kb, "应急响应.txt", ["应急响应流程先记录现场，再通知值班人员。"])
        db.add(EmbeddingProfile(fingerprint="active-profile", model_name="fake", dimension=2))
        db.flush()
        stages = []
        found = search_knowledge(db, get_actor(db), {"query": "应急响应流程"}, Settings(),
                                 on_progress=lambda stage, details: stages.append((stage, details)))
        assert found["mode"] == "keyword"
        assert "测试向量服务暂不可用" in found["notice"]
        assert found["items"][0]["document_id"] == target.id
        assert [stage for stage, _ in stages] == ["keyword", "embedding", "ranking"]
        embedding_details = next(details for stage, details in stages if stage == "embedding")
        assert embedding_details == {"query_count": 1, "knowledge_bases": 1}
        assert "queries" not in embedding_details  # Reserved for search-round string arrays.


def test_scope_folder_tags_and_current_embedding_profile_are_preserved(client, factory, monkeypatch):
    class Gateway:
        embeddings_configured = True
        profile_fingerprint = "current"

        def __init__(self, _settings):
            pass

        def embed(self, texts):
            assert texts == ["unique semantic question"]
            return [[1.0, 0.0]]

    monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
    kb = client.get("/api/knowledge-bases").json()[0]
    other_kb = client.post("/api/knowledge-bases", json={"name": "另一个范围"}).json()
    folder = client.post(f"/api/knowledge-bases/{kb['id']}/folders", json={"name": "选中目录"}).json()
    tag = client.post(f"/api/knowledge-bases/{kb['id']}/tags", json={"name": "公开"}).json()
    with factory() as db:
        from app.db.models import DocumentTag

        selected = document(db, db.get(KnowledgeBase, kb["id"]), "selected.txt", ["选定的语义材料"], folder_id=folder["id"])
        wrong_folder = document(db, db.get(KnowledgeBase, kb["id"]), "wrong folder.txt", ["范围外的语义材料"])
        foreign = document(db, db.get(KnowledgeBase, other_kb["id"]), "foreign.txt", ["其他知识库的语义材料"])
        stale = document(db, db.get(KnowledgeBase, kb["id"]), "old profile.txt", ["旧模型语义材料"], folder_id=folder["id"])
        current_profile = EmbeddingProfile(fingerprint="current", model_name="current", dimension=2)
        old_profile = EmbeddingProfile(fingerprint="old", model_name="old", dimension=2)
        db.add_all([current_profile, old_profile])
        db.flush()
        for doc in (selected, wrong_folder, foreign, stale):
            chunk = db.scalar(select(DocumentChunk).where(DocumentChunk.document_id == doc.id))
            profile = old_profile if doc.id == stale.id else current_profile
            db.add(ChunkEmbedding(kb_id=doc.kb_id, chunk_id=chunk.id, profile_id=profile.id, embedding=[1.0, 0.0]))
            if doc.kb_id == kb["id"]:
                db.add(DocumentTag(document_id=doc.id, tag_id=tag["id"], kb_id=doc.kb_id))
        db.flush()
        result = search_knowledge(db, get_actor(db), {"query": "unique semantic question", "kb_ids": [kb["id"]],
            "folder_ids": [folder["id"]], "tag_ids": [tag["id"]]}, Settings())
        assert result["mode"] == "hybrid"
        assert [hit["document_id"] for hit in result["items"]] == [selected.id]


@pytest.mark.parametrize("with_callback", [False, True])
@pytest.mark.parametrize("wait_stage", ["embedding", "reranking"])
@pytest.mark.parametrize("change", ["membership", "knowledge_base", "document", "folder", "move", "tag"])
def test_provider_wait_revalidates_access_and_source_scope(client, factory, monkeypatch, change, with_callback, wait_stage):
    from app.core.errors import AppError
    from app.db.models import DocumentTag, Folder

    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    folder = client.post(f"/api/knowledge-bases/{kb_id}/folders", json={"name": "范围内"}).json()
    other = client.post(f"/api/knowledge-bases/{kb_id}/folders", json={"name": "范围外"}).json()
    tag = client.post(f"/api/knowledge-bases/{kb_id}/tags", json={"name": "允许搜索"}).json()
    with factory() as db:
        target = document(db, db.get(KnowledgeBase, kb_id), "可撤回来源.txt", ["检索权限在模型等待期间改变，不得泄露这段资料。"], folder_id=folder["id"])
        document_id = target.id
        db.add(DocumentTag(document_id=target.id, kb_id=kb_id, tag_id=tag["id"]))
        db.add(EmbeddingProfile(fingerprint="scope-profile", model_name="fake", dimension=2))
        db.commit()

    class Gateway:
        embeddings_configured = True
        llm_configured = True
        profile_fingerprint = "scope-profile"

        def __init__(self, settings):
            self.settings = settings

        def change_scope(self):
            with factory() as writer:
                if change == "membership":
                    writer.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb_id))
                elif change == "knowledge_base":
                    writer.get(KnowledgeBase, kb_id).deleted_at = utcnow()
                elif change == "document":
                    writer.get(Document, document_id).deleted_at = utcnow()
                elif change == "folder":
                    writer.get(Folder, folder["id"]).deleted_at = utcnow()
                elif change == "move":
                    writer.get(Document, document_id).folder_id = other["id"]
                else:
                    writer.execute(delete(DocumentTag).where(DocumentTag.document_id == document_id))
                writer.commit()

        def embed(self, _texts):
            if wait_stage == "embedding":
                self.change_scope()
            return [[1.0, 0.0]]

        def chat(self, *_args, **_kwargs):
            assert self.settings.llm_timeout_seconds <= 12
            assert self.settings.llm_max_retries == 0
            if wait_stage == "reranking":
                self.change_scope()
            return '{"ranked_ids":["C1"]}'

    monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
    with factory() as db:
        request = {"query": "检索权限", "kb_ids": [kb_id], "folder_ids": [folder["id"]], "tag_ids": [tag["id"]]}
        progress = (lambda *_: None) if with_callback else None
        if change in {"membership", "knowledge_base", "folder"}:
            with pytest.raises(AppError):
                search_knowledge(db, get_actor(db), request, Settings(), on_progress=progress, rerank=True)
        else:
            assert search_knowledge(db, get_actor(db), request, Settings(), on_progress=progress, rerank=True)["items"] == []


def test_ordinary_search_never_calls_chat_reranker(factory, monkeypatch):
    class Gateway:
        embeddings_configured = False
        llm_configured = True

        def __init__(self, _settings):
            pass

        def chat(self, *_args, **_kwargs):
            raise AssertionError("ordinary search must not call LLM")

    monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        target = document(db, kb, "检索边界.txt", ["普通搜索只使用本地排序与向量，不额外请求聊天模型。"])
        result = search_knowledge(db, get_actor(db), {"query": "普通搜索"}, Settings())
        assert result["items"][0]["document_id"] == target.id
        assert result["reranking"]["status"] == "skipped"


@pytest.mark.parametrize(("name", "question", "expected"), [
    ("年度人员资格申请表.docx", "今年资格政策有什么要求？", 0.4),
    ("项目申报表.docx", "年度项目如何遴选？", 0.4),
    ("项目申报表.docx", "项目申报表怎么填写？", 1.0),
    ("人员登记表.docx", "给我一份表格", 1.0),
    ("年度申请统计表.xlsx", "今年人数多少？", 1.0),
    ("报名表数据汇总.xlsx", "报名人数怎样分布？", 1.0),
    ("年度预算分配表.xlsx", "预算如何分配？", 1.0),
    ("申请表填写指南.pdf", "怎么申请？", 1.0),
    ("Application form.docx", "What are the eligibility policies?", 0.4),
    ("Application form.docx", "How do I fill in the form?", 1.0),
])
def test_generic_document_purpose_preserves_forms_data_and_guides(name, question, expected):
    from types import SimpleNamespace

    doc = SimpleNamespace(display_name=name, summary_status="failed", short_summary="")
    assert document_purpose_weight(doc, question) == expected


def test_form_requests_remain_discoverable_without_generated_summaries(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        form = document(db, kb, "研究中心项目申请表.txt", ["研究中心项目申请表：姓名、专业、申报类别，请填写完整后签名。"])
        document(db, kb, "研究中心项目实施办法.txt", ["研究中心项目按综合评价排序，名额在公开审核后分配。"])
        result = search_knowledge(db, get_actor(db), {"query": "研究中心项目申请表怎么填写？", "mode": "keyword"}, Settings())
        assert result["items"][0]["document_id"] == form.id


def test_search_api_model_reranking_is_explicit_and_single_call(client, factory, monkeypatch):
    calls = []

    class Gateway:
        embeddings_configured = False
        llm_configured = True

        def __init__(self, _settings):
            pass

        def chat(self, messages, **options):
            calls.append((messages, options))
            return '{"ranked_ids":["C1"]}'

    monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        kb_id = kb.id
        source = document(db, kb, "项目政策.txt", ["项目政策依据公开评价流程执行，名额以正式公告为准。"])
        document_id = source.id
        db.commit()
    request = {"query": "项目政策如何执行？", "kb_ids": [kb_id]}
    ordinary = client.post("/api/search", json=request)
    assert ordinary.status_code == 200 and calls == []
    assert ordinary.json()["reranking"]["status"] == "skipped"
    checked = client.post("/api/search", json={**request, "rerank": True})
    assert checked.status_code == 200 and len(calls) == 1
    assert checked.json()["reranking"]["status"] == "completed"
    assert checked.json()["items"][0]["document_id"] == document_id
    assert calls[0][1] == {"json_mode": True, "max_tokens": 400}
