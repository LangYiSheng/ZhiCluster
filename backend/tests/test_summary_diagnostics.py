import json
from types import SimpleNamespace

import pytest

from app.ai.gateway import ProviderError
from app.ingestion.enrichment import enrich_sections, summarize_sections
from app.ingestion.enrichment_types import validate_summary

VALID = {"short_summary": "简短事实。", "detailed_summary": "资料中的关键事实。", "keywords": ["事实"], "main_topics": ["资料"]}


@pytest.mark.parametrize(("field", "invalid", "kind"), [
    ("short_summary", None, "string_type"),
    ("short_summary", "", "string_too_short"),
    ("detailed_summary", "x" * 8001, "string_too_long"),
    ("detailed_summary", ["PROVIDER_PRIVATE_VALUE"], "string_type"),
    ("keywords", "PROVIDER_PRIVATE_VALUE", "list_type"),
    ("keywords", [None], "string_type"),
    ("main_topics", ["topic"] * 13, "too_long"),
])
def test_summary_diagnostics_include_only_known_field_and_error_type(field, invalid, kind):
    with pytest.raises(ProviderError) as raised:
        validate_summary({**VALID, field: invalid})
    assert f"{field}:{kind}" in str(raised.value)
    assert "PROVIDER_PRIVATE_VALUE" not in str(raised.value)
    assert "http" not in str(raised.value)
    assert raised.value.__cause__ is None


def test_unknown_keys_and_nested_values_are_never_echoed_in_summary_diagnostics():
    with pytest.raises(ProviderError) as raised:
        validate_summary({**VALID, "SECRET_PROVIDER_KEY": {"arbitrary": "PRIVATE_PROVIDER_VALUE"}})
    assert "summary:extra_forbidden" in str(raised.value)
    assert "SECRET_PROVIDER_KEY" not in str(raised.value)
    assert "PRIVATE_PROVIDER_VALUE" not in str(raised.value)
    assert "arbitrary" not in str(raised.value)
    assert validate_summary(VALID).model_dump() == VALID


def test_missing_field_is_named_but_non_object_diagnostic_is_generic():
    with pytest.raises(ProviderError, match="short_summary:missing"):
        validate_summary({"detailed_summary": "事实"})
    with pytest.raises(ProviderError, match="summary:model_type"):
        validate_summary(None)


def test_standalone_and_joint_summary_use_identical_sanitized_validation():
    config = SimpleNamespace(summary_input_tokens=6000, summary_max_calls=1, max_concurrent_model_calls=3)
    sections = [SimpleNamespace(plain_text="简短事实资料。", section_summary="")]
    invalid = {**VALID, "detailed_summary": "x" * 8001}
    classification = {"existing_folder_id": None, "existing_tag_ids": [], "new_tag_names": [], "reason": "事实"}

    class Gateway:
        def chat(self, messages, **kwargs):
            payload = {"summary": invalid, "classification": classification} if "同时生成文档摘要与分类建议" in messages[0]["content"] else invalid
            return json.dumps(payload)

    with pytest.raises(ProviderError, match="detailed_summary:string_too_long") as standalone:
        summarize_sections(sections, Gateway(), config)
    joint = enrich_sections(sections, "资料", [], [], Gateway(), config)
    assert str(joint.errors["summary"]) == str(standalone.value)
    assert joint.classification is not None
    assert set(joint.errors) == {"summary"}
