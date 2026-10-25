"""Keep stored provider model identifiers aligned with the 512-character inputs."""

import sqlalchemy as sa

from alembic import op

revision = "07_model_identifiers"
down_revision = "06_workspace_personalization"
branch_labels = None
depends_on = None


def _resize(length, previous_length):
    for table, column in (("embedding_profiles", "model_name"), ("classification_suggestions", "model")):
        # Alembic rebuilds SQLite tables and emits ALTER COLUMN for PostgreSQL.
        with op.batch_alter_table(table) as batch:
            batch.alter_column(column, existing_type=sa.String(previous_length), type_=sa.String(length),
                existing_nullable=False)


def upgrade():
    _resize(512, 200)


def downgrade():
    # PostgreSQL refuses shrinking while long identifiers exist; never truncate.
    _resize(200, 512)
