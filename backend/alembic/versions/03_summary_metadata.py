"""Persist summary keywords and main topics alongside textual summaries."""
from alembic import op
import sqlalchemy as sa

revision = "03_summary_metadata"
down_revision = "0d493e6493d4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("documents", sa.Column("summary_metadata", sa.JSON(), nullable=False, server_default="{}"))
    op.alter_column("documents", "summary_metadata", server_default=None)


def downgrade():
    op.drop_column("documents", "summary_metadata")
