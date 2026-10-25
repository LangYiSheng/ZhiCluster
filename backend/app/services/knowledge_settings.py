"""Resolve the embedding profile for one library without changing chat settings."""


def settings_for_knowledge_base(settings, knowledge_base):
    updates = {}
    if knowledge_base and knowledge_base.embedding_model:
        updates["embedding_model"] = knowledge_base.embedding_model
    if knowledge_base and knowledge_base.embedding_dimension:
        updates["embedding_dimension"] = knowledge_base.embedding_dimension
    return settings.model_copy(update=updates, deep=True) if updates else settings


def chat_models(settings):
    return list(dict.fromkeys(filter(None, [settings.llm_model, *settings.llm_models])))
