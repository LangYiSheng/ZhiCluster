"""Persist versioned runtime settings and encrypted provider credentials."""

import sqlalchemy as sa

from alembic import op

revision = "04_runtime_configuration"
down_revision = "03_summary_metadata"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "app_configurations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("values", sa.JSON(), nullable=False),
        sa.Column("secrets", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("app_configurations")
