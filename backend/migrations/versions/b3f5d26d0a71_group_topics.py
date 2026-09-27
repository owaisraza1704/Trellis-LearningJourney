"""Remove legacy conversations from topics that now group subtopics."""

from alembic import op
import sqlalchemy as sa

revision = "b3f5d26d0a71"
down_revision = "a47d8e290c61"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    groups = "SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL"

    # Notebook items retain their saved content and origin snapshot after the conversation is removed.
    connection.execute(sa.text(f"""
        UPDATE notebookitem SET interaction_id = NULL, thread_id = NULL
        WHERE node_id IN ({groups})
    """))
    connection.execute(sa.text(f"""
        DELETE FROM activity WHERE node_id IN ({groups})
        AND kind IN ('interaction', 'thread_interaction', 'thread_created', 'progress')
    """))
    connection.execute(sa.text(f"""
        UPDATE activity SET interaction_id = NULL, thread_id = NULL
        WHERE node_id IN ({groups})
    """))
    connection.execute(sa.text(f"""
        UPDATE learningsession SET node_id = NULL, thread_id = NULL
        WHERE node_id IN ({groups})
    """))
    connection.execute(sa.text(f"""
        UPDATE workspace SET node_id = NULL, thread_id = NULL
        WHERE node_id IN ({groups})
    """))
    connection.execute(sa.text(f"DELETE FROM interaction WHERE node_id IN ({groups})"))
    connection.execute(sa.text(f"DELETE FROM thread WHERE node_id IN ({groups})"))
    connection.execute(sa.text(f"UPDATE node SET status = 'not_started' WHERE id IN ({groups})"))


def downgrade():
    # Removed conversations cannot be reconstructed.
    pass
