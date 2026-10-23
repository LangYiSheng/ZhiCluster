import json
from types import SimpleNamespace

import pytest

from app.ingestion.chunking import count_tokens
from app.ingestion.enrichment import enrich_sections

SUMMARY = {"short_summary": "九月提交申请。", "detailed_summary": "申请时间为九月，提交成绩单与申请表。", "keywords": ["申请"], "main_topics": ["研究生申请"]}
CLASSIFICATION = {"existing_folder_id": None, "existing_tag_ids": [], "new_tag_names": ["申请"], "short_summary": "申请说明。", "reason": "资料说明申请流程。"}


def settings(**overrides):
    return SimpleNamespace(**{"summary_input_tokens": 1800, "summary_max_calls": 30, "max_concurrent_model_calls": 3, **overrides})


class Gateway:
    def __init__(self, output):
        self.output, self.calls = output, []

    def chat(self, messages, *, json_mode=False, max_tokens=0):
        self.calls.append((messages, json_mode, max_tokens))
        return json.dumps(self.output)


def test_short_document_summary_and_classification_share_one_paid_call():
    gateway = Gateway({"summary": SUMMARY, "classification": CLASSIFICATION})
    result = enrich_sections([SimpleNamespace(plain_text="九月申请，提交成绩单与申请表。", section_summary="")], "申请说明", [], [], gateway, settings(summary_max_calls=1))
    assert result.summary.short_summary == SUMMARY["short_summary"]
    assert result.classification.new_tag_names == ["申请"]
    assert not result.errors and len(gateway.calls) == 1
    messages, json_mode, budget = gateway.calls[0]
    assert json_mode and budget >= 1200
    assert "summary 和 classification" in messages[0]["content"]


@pytest.mark.parametrize("bad_stage", ["summary", "classification"])
def test_invalid_half_of_joint_response_does_not_discard_valid_paid_result(bad_stage):
    payload = {"summary": SUMMARY, "classification": CLASSIFICATION, bad_stage: {"unknown_field": "invalid"}}
    gateway = Gateway(payload)
    result = enrich_sections([SimpleNamespace(plain_text="申请说明。", section_summary="")], "资料", [], [], gateway, settings())
    assert set(result.errors) == {bad_stage}
    assert (result.summary is None) == (bad_stage == "summary")
    assert (result.classification is None) == (bad_stage == "classification")
    assert len(gateway.calls) == 1


def test_joint_classification_validates_catalog_ids_and_normalized_aliases():
    payload = {"summary": SUMMARY, "classification": {**CLASSIFICATION, "existing_folder_id": "folder", "new_tag_names": [" ＬＬＭ ", "申请"]}}
    folders = [{"id": "folder", "name": "研究"}]
    tags = [{"id": "tag", "name": "模型", "aliases": ["LLM"]}]
    result = enrich_sections([SimpleNamespace(plain_text="模型研究申请说明。", section_summary="")], "资料", folders, tags, Gateway(payload), settings())
    assert result.classification.existing_tag_ids == ["tag"]
    assert result.classification.new_tag_names == ["申请"]
    result = enrich_sections([SimpleNamespace(plain_text="资料", section_summary="")], "资料", [], tags, Gateway(payload), settings())
    assert result.summary and "classification" in result.errors


def test_small_sections_are_packed_with_independent_section_checkpoints_then_joint_final():
    requests, checkpoints = [], []
    sections = [SimpleNamespace(plain_text=f"章节{i}：九月申请，提交成绩单与申请表。" * 5, section_summary="") for i in range(12)]

    class PackedGateway:
        def chat(self, messages, *, json_mode=False, max_tokens=0):
            requests.append(messages)
            if "同时生成文档摘要与分类建议" in messages[0]["content"]:
                return json.dumps({"summary": SUMMARY, "classification": CLASSIFICATION})
            if json_mode:
                payload = json.loads(messages[-1]["content"])
                assert count_tokens(messages[-1]["content"]) < 1800
                return json.dumps({"sections": [{"id": section["id"], "summary": f"章节{section['id']}独立申请事实。"} for section in payload["sections"]]})
            return "单独章节事实。"

    result = enrich_sections(sections, "申请说明", [], [], PackedGateway(), settings(), lambda index, summary: checkpoints.append((index, summary)))
    assert result.summary and result.classification and not result.errors
    assert len(requests) < len(sections) + 1
    assert len(checkpoints) == len(sections)
    assert all(f"章节{index}" in summary for index, summary in checkpoints)
    assert sum("同时生成文档摘要与分类建议" in request[0]["content"] for request in requests) == 1


def test_bad_packed_section_ids_keep_completed_checkpoints_and_never_cross_assign():
    checkpoints = []
    sections = [SimpleNamespace(plain_text=f"章节{i}申请材料与时间说明。" * 8, section_summary="") for i in range(12)]

    class Gateway:
        calls = 0

        def chat(self, messages, *, json_mode=False, **kwargs):
            self.calls += 1
            payload = json.loads(messages[-1]["content"])
            assert "sections" in payload
            entries = [{"id": item["id"], "summary": f"章节{item['id']}事实。"} for item in payload["sections"]]
            if self.calls == 2:
                entries[0]["id"] = 9999
            return json.dumps({"sections": entries})

    result = enrich_sections(sections, "材料", [], [], Gateway(), settings(summary_input_tokens=1400, max_concurrent_model_calls=1), lambda index, summary: checkpoints.append((index, summary)))
    assert set(result.errors) == {"summary", "classification"}
    assert checkpoints and len(checkpoints) < len(sections)
    assert all(f"章节{index}" in summary for index, summary in checkpoints)
