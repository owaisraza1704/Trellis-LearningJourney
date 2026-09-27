"""Remember which answer a follow-up targets."""

from alembic import op
import sqlalchemy as sa


revision = "c642a9fe8221"
down_revision = "b3f5d26d0a71"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("interaction", sa.Column("reply_to_interaction_id", sa.String(), nullable=True))
    op.create_foreign_key(
        "fk_interaction_reply_to_interaction_id", "interaction", "interaction",
        ["reply_to_interaction_id"], ["id"], ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint("fk_interaction_reply_to_interaction_id", "interaction", type_="foreignkey")
    op.drop_column("interaction", "reply_to_interaction_id")
