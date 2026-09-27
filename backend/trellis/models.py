from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import CheckConstraint, Column, DateTime, JSON
from sqlmodel import Field, SQLModel


def new_id() -> str:
    return str(uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Record(SQLModel):
    id: str = Field(default_factory=new_id, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class LearningPath(Record, table=True):
    title: str
    description: str = ""
    input: str
    generation: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    updated_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class Node(Record, table=True):
    __table_args__ = (CheckConstraint("status IN ('not_started','in_progress','completed')"),)
    path_id: str = Field(foreign_key="learningpath.id", index=True)
    parent_id: str | None = Field(default=None, foreign_key="node.id")
    title: str
    description: str = ""
    position: int = 0
    status: str = "not_started"
    evidence_ids: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))


class Thread(Record, table=True):
    __table_args__ = (CheckConstraint("status IN ('open','closed')"),)
    path_id: str = Field(foreign_key="learningpath.id", index=True)
    node_id: str = Field(foreign_key="node.id", index=True)
    title: str
    status: str = "open"
    seed_context: str = ""


class Interaction(Record, table=True):
    path_id: str = Field(foreign_key="learningpath.id", index=True)
    node_id: str = Field(foreign_key="node.id", index=True)
    thread_id: str | None = Field(default=None, foreign_key="thread.id", index=True)
    reply_to_interaction_id: str | None = Field(
        default=None, foreign_key="interaction.id", ondelete="SET NULL",
    )
    prompt: str
    content: str
    action: str = "question"
    status: str = "answered"
    evidence: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    evaluation: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    provider: str = ""
    model: str = ""


class Workspace(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    path_id: str | None = Field(default=None, foreign_key="learningpath.id")
    node_id: str | None = Field(default=None, foreign_key="node.id")
    thread_id: str | None = Field(default=None, foreign_key="thread.id")


class LearningSession(Record, table=True):
    path_id: str = Field(foreign_key="learningpath.id", index=True)
    node_id: str | None = Field(default=None, foreign_key="node.id")
    thread_id: str | None = Field(default=None, foreign_key="thread.id")
    started_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    last_active_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    ended_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class Activity(Record, table=True):
    path_id: str | None = Field(default=None, foreign_key="learningpath.id", index=True)
    node_id: str | None = Field(default=None, foreign_key="node.id")
    thread_id: str | None = Field(default=None, foreign_key="thread.id")
    interaction_id: str | None = Field(default=None, foreign_key="interaction.id", ondelete="SET NULL")
    notebook_item_id: str | None = Field(default=None, foreign_key="notebookitem.id", ondelete="SET NULL")
    kind: str
    label: str


class Source(Record, table=True):
    path_id: str | None = Field(default=None, foreign_key="learningpath.id", index=True)
    title: str
    kind: str
    url: str | None = None
    status: str = "pending"
    error: str | None = None
    chunk_count: int = 0
    file_path: str | None = None
    content: str = ""


class Chunk(Record, table=True):
    source_id: str = Field(foreign_key="source.id", index=True)
    content: str
    location: str = ""
    position: int = 0
    profile: str = Field(index=True)
    embedding: Any = Field(sa_column=Column(Vector()))


class AppSettings(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    provider: str = "azure"
    model: str = ""


class NotebookPage(Record, table=True):
    path_id: str | None = Field(default=None, foreign_key="learningpath.id", index=True)
    title: str
    position: int = 0


class NotebookItem(Record, table=True):
    page_id: str = Field(foreign_key="notebookpage.id", index=True)
    title: str
    content: str
    position: int = 0
    kind: str = "note"
    path_id: str | None = Field(default=None, foreign_key="learningpath.id")
    node_id: str | None = Field(default=None, foreign_key="node.id")
    thread_id: str | None = Field(default=None, foreign_key="thread.id")
    interaction_id: str | None = Field(default=None, foreign_key="interaction.id")
    origin: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    evidence: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))


class StudySet(Record, table=True):
    path_id: str | None = Field(default=None, foreign_key="learningpath.id", index=True)
    title: str
    item_ids: list[str] = Field(default_factory=list, sa_column=Column(JSON))


class ExportRecord(Record, table=True):
    path_id: str | None = Field(default=None, foreign_key="learningpath.id", index=True)
    title: str
    status: str = "pending"
    error: str | None = None
    file_path: str | None = None
    study_session_id: str | None = Field(default=None, foreign_key="studyset.id")
    snapshot: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
