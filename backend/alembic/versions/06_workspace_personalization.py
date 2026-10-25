"""Knowledge appearance, per-library embedding and conversation ownership."""

import sqlalchemy as sa

from alembic import op

revision = "06_workspace_personalization"
down_revision = "05_storage_deletions"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("knowledge_bases", sa.Column("icon", sa.String(50), nullable=False, server_default="folder"))
    op.add_column("knowledge_bases", sa.Column("color", sa.String(7), nullable=False, server_default="#55a995"))
    op.add_column("knowledge_bases", sa.Column("embedding_model", sa.String(512), nullable=True))
    op.add_column("knowledge_bases", sa.Column("embedding_dimension", sa.Integer(), nullable=True))
    op.add_column("conversations", sa.Column("kb_id", sa.String(36), nullable=True))
    op.create_index("ix_conversations_kb_id", "conversations", ["kb_id"])
    if op.get_bind().dialect.name == "postgresql":
        op.execute("UPDATE conversations SET kb_id = scope->'kb_ids'->>0 WHERE scope->'kb_ids'->>0 IS NOT NULL")
    else:
        op.execute("UPDATE conversations SET kb_id = json_extract(scope, '$.kb_ids[0]')")


def downgrade():
    op.drop_index("ix_conversations_kb_id", table_name="conversations")
    op.drop_column("conversations", "kb_id")
    for column in ("embedding_dimension", "embedding_model", "color", "icon"):
        op.drop_column("knowledge_bases", column)
