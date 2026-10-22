"""Enforce same-KB associations and add Chinese substring search indexes."""
from alembic import op

revision = "0d493e6493d4"
down_revision = "14703c2af5e7"
branch_labels = None
depends_on = None

UNIQUES = [("folders", "uq_folders_id_kb"), ("documents", "uq_documents_id_kb"), ("document_sections", "uq_sections_id_kb"), ("document_chunks", "uq_chunks_id_kb"), ("tags", "uq_tags_id_kb")]
FOREIGN_KEYS = [
    ("folders", "folders", "parent_id", "fk_folder_parent_same_kb"),
    ("documents", "folders", "folder_id", "fk_document_folder_same_kb"),
    ("document_sections", "documents", "document_id", "fk_section_document_same_kb"),
    ("document_chunks", "documents", "document_id", "fk_chunk_document_same_kb"),
    ("document_chunks", "document_sections", "section_id", "fk_chunk_section_same_kb"),
    ("chunk_embeddings", "document_chunks", "chunk_id", "fk_embedding_chunk_same_kb"),
    ("document_tags", "documents", "document_id", "fk_document_tag_document_same_kb"),
    ("document_tags", "tags", "tag_id", "fk_document_tag_tag_same_kb"),
]


def upgrade():
    for table, name in UNIQUES:
        op.create_unique_constraint(name, table, ["id", "kb_id"])
    for source, target, column, name in FOREIGN_KEYS:
        op.create_foreign_key(name, source, target, [column, "kb_id"], ["id", "kb_id"])
    op.create_check_constraint("folder_not_self_parent", "folders", "parent_id IS NULL OR parent_id <> id")
    op.create_check_constraint("valid_member_role", "knowledge_base_members", "role IN ('owner','editor','viewer')")
    op.execute("CREATE INDEX ix_chunks_content_trgm ON document_chunks USING gin (content gin_trgm_ops)")
    op.execute("CREATE INDEX ix_documents_name_trgm ON documents USING gin (display_name gin_trgm_ops)")
    op.execute("CREATE UNIQUE INDEX uq_folder_sibling_name ON folders (kb_id, coalesce(parent_id, ''), lower(trim(name))) WHERE deleted_at IS NULL")


def downgrade():
    for index in ["uq_folder_sibling_name", "ix_documents_name_trgm", "ix_chunks_content_trgm"]:
        op.drop_index(index)
    op.drop_constraint("valid_member_role", "knowledge_base_members", type_="check")
    op.drop_constraint("folder_not_self_parent", "folders", type_="check")
    for source, _, _, name in reversed(FOREIGN_KEYS):
        op.drop_constraint(name, source, type_="foreignkey")
    for table, name in reversed(UNIQUES):
        op.drop_constraint(name, table, type_="unique")
