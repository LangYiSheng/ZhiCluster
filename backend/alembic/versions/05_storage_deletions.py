"""Durable source-file cleanup for permanently deleted trash."""

import sqlalchemy as sa

from alembic import op

revision = "05_storage_deletions"
down_revision = "04_runtime_configuration"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "storage_deletions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("storage_key", sa.String(255), nullable=False, unique=True),
        sa.Column("owner_id", sa.String(36), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
    )
    op.create_index("ix_storage_deletions_owner_id", "storage_deletions", ["owner_id"])


def downgrade():
    op.drop_table("storage_deletions")
