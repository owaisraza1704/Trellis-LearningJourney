import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field as InputField, model_validator
from sqlalchemy import delete, func, update
from sqlmodel import Session, select

from . import ai
from .config import settings
from .db import get_session
from .models import (
    Activity, Chunk, ExportRecord, Interaction, LearningPath, LearningSession, Node, NotebookItem,
    NotebookPage, Source, StudySet, Thread, Workspace, utcnow,
)

router = APIRouter()
logger = logging.getLogger(__name__)
WITHHELD_ANSWER = "The previous answer was withheld because its support could not be verified."


class RequestBody(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)


def require(session: Session, model, record_id: str):
    record = session.get(model, record_id)
    if record is None:
        raise HTTPException(404, f"{model.__name__} not found.")
    return record


def workspace(session: Session) -> Workspace:
    row = session.get(Workspace, 1)
    if row is None:
        row = Workspace()
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def path_detail(session: Session, path: LearningPath) -> dict:
    nodes = session.exec(select(Node).where(Node.path_id == path.id).order_by(Node.position)).all()
    children_by_parent: dict[str, list[Node]] = {}
    for node in nodes:
        if node.parent_id:
            children_by_parent.setdefault(node.parent_id, []).append(node)

    def visible_status(node: Node) -> str:
        children = children_by_parent.get(node.id, [])
        if not children:
            return node.status
        statuses = [visible_status(child) for child in children]
        if all(status == "completed" for status in statuses):
            return "completed"
        if any(status != "not_started" for status in statuses):
            return "in_progress"
        return "not_started"

    learning_nodes = [node for node in nodes if node.id not in children_by_parent]
    completed = sum(node.status == "completed" for node in learning_nodes)
    return {
        **path.model_dump(),
        "nodes": [{**node.model_dump(), "status": visible_status(node)} for node in nodes],
        "node_count": len(learning_nodes), "completed_count": completed,
        "progress": round(100 * completed / len(learning_nodes)) if learning_nodes else 0,
    }


def require_learning_node(session: Session, node: Node):
    if session.exec(select(Node.id).where(Node.parent_id == node.id)).first():
        raise HTTPException(409, "This topic groups subtopics. Open a child topic to study.")


def require_available_group(session: Session, node: Node):
    if session.exec(select(Node.id).where(Node.parent_id == node.id)).first():
        return
    has_study = (
        node.status != "not_started"
        or session.exec(select(Interaction.id).where(Interaction.node_id == node.id)).first()
        or session.exec(select(Thread.id).where(Thread.node_id == node.id)).first()
        or session.exec(select(NotebookItem.id).where(NotebookItem.node_id == node.id)).first()
        or session.exec(select(LearningSession.id).where(LearningSession.node_id == node.id)).first()
    )
    if has_study:
        raise HTTPException(409, "A studied topic cannot become a group. Add a new parent topic instead.")


def activity(session: Session, kind: str, label: str, node: Node | None = None,
             thread: Thread | None = None, path_id: str | None = None,
             interaction_id: str | None = None, notebook_item_id: str | None = None):
    session.add(Activity(kind=kind, label=label, path_id=node.path_id if node else path_id,
                         node_id=node.id if node else None, thread_id=thread.id if thread else None,
                         interaction_id=interaction_id, notebook_item_id=notebook_item_id))
    if node or path_id:
        path = require(session, LearningPath, node.path_id if node else path_id)
        path.updated_at = utcnow()
        session.add(path)
    if node and kind in {"interaction", "thread_interaction", "thread_created", "progress"}:
        period = session.exec(select(LearningSession).where(
            LearningSession.ended_at.is_(None), LearningSession.path_id == node.path_id,
            LearningSession.node_id == node.id,
        ).order_by(LearningSession.started_at.desc())).first()
        if period:
            period.last_active_at = utcnow()
            session.add(period)


def safe_thread_seed(session: Session, thread: Thread) -> str:
    # Older threads copied withheld diagnostics before seeds distinguished accepted answers.
    sources = session.exec(select(Interaction).where(
        Interaction.node_id == thread.node_id, Interaction.thread_id.is_(None),
        Interaction.status == "abstained",
    )).all()
    for source in sources:
        suffix = f"\nStarting question: {source.prompt}\nStarting explanation: {source.content}"
        if thread.seed_context.endswith(suffix):
            return (thread.seed_context.removesuffix(suffix)
                    + f"\nStarting question: {source.prompt}\nStarting explanation: {WITHHELD_ANSWER}")
    return thread.seed_context


def build_context(session: Session, node: Node, thread: Thread | None = None) -> dict:
    path = require(session, LearningPath, node.path_id)
    path_summary = path_detail(session, path)
    query = select(Interaction).where(Interaction.node_id == node.id)
    query = query.where(Interaction.thread_id == thread.id) if thread else query.where(
        Interaction.thread_id.is_(None)
    )
    interactions = session.exec(query.order_by(Interaction.created_at.desc()).limit(12)).all()
    ancestors = []
    parent_id = node.parent_id
    while parent_id:
        parent = require(session, Node, parent_id)
        ancestors.insert(0, {"title": parent.title, "description": parent.description})
        parent_id = parent.parent_id
    context = {
        "path_id": path.id, "path_title": path.title, "node_id": node.id,
        "node_title": node.title, "node_description": node.description,
        "node_position": node.position,
        "node_count": path_summary["node_count"],
        "ancestors": ancestors, "progress": path_summary["progress"],
        "history": [{"prompt": item.prompt,
                     "content": item.content if item.status != "abstained" else WITHHELD_ANSWER,
                     "status": item.status, "sources_only": item.evaluation.get("sources_only", False)}
                    for item in reversed(interactions)],
    }
    if thread:
        context.update(thread_id=thread.id, thread_title=thread.title,
                       seed_context=safe_thread_seed(session, thread))
    return context


class PathInput(RequestBody):
    input: str = InputField(min_length=3, max_length=20000)
    mode: Literal["goal", "outline"] = "goal"
    source_ids: list[str] = InputField(default_factory=list, max_length=30)


class DraftNode(RequestBody):
    title: str = InputField(min_length=1, max_length=300)
    description: str = InputField(default="", max_length=5000)
    parent_index: int | None = None
    evidence_ids: list[str] = InputField(default_factory=list)


class CurriculumDraft(RequestBody):
    title: str = InputField(min_length=1, max_length=300)
    description: str = ""
    nodes: list[DraftNode] = InputField(min_length=1, max_length=100)

    @model_validator(mode="after")
    def ordered_hierarchy(self):
        for index, node in enumerate(self.nodes):
            if node.parent_index is not None and not 0 <= node.parent_index < index:
                raise ValueError("A parent must be a preceding node.")
        return self


class PathEdit(RequestBody):
    title: str | None = InputField(default=None, min_length=1, max_length=300)
    description: str | None = InputField(default=None, max_length=5000)


class NodeInput(RequestBody):
    title: str = InputField(min_length=1, max_length=300)
    description: str = InputField(default="", max_length=5000)
    parent_id: str | None = None


class NodeEdit(PathEdit):
    parent_id: str | None = None


class ReorderInput(RequestBody):
    node_ids: list[str]


class ProgressInput(RequestBody):
    status: Literal["not_started", "in_progress", "completed"]


class MessageInput(RequestBody):
    prompt: str = InputField(min_length=1, max_length=12000)
    action: Literal["foundation", "question", "example", "deeper", "comparison", "application"] = "question"
    sources_only: bool = False


class ThreadInput(RequestBody):
    title: str = InputField(min_length=1, max_length=300)
    interaction_id: str | None = None


class ThreadEdit(RequestBody):
    title: str | None = InputField(default=None, min_length=1, max_length=300)
    status: Literal["open", "closed"] | None = None


class LocationInput(RequestBody):
    path_id: str | None = None
    node_id: str | None = None
    thread_id: str | None = None


@router.get("/paths")
def list_paths(session: Session = Depends(get_session)):
    paths = session.exec(select(LearningPath).order_by(LearningPath.updated_at.desc())).all()
    node_rows = session.exec(select(Node.path_id, Node.id, Node.parent_id, Node.status)).all()
    group_ids = {parent_id for _, _, parent_id, _ in node_rows if parent_id}
    node_counts: dict[str, tuple[int, int]] = {}
    for path_id, node_id, _, status in node_rows:
        if node_id in group_ids:
            continue
        count, completed = node_counts.get(path_id, (0, 0))
        node_counts[path_id] = (count + 1, completed + (status == "completed"))
    latest_sessions = {
        period.path_id: period
        for period in session.exec(select(LearningSession)
            .where(LearningSession.node_id.is_not(None))
            .distinct(LearningSession.path_id)
            .order_by(LearningSession.path_id, LearningSession.last_active_at.desc(),
                      LearningSession.started_at.desc(), LearningSession.id)).all()
    }
    notebook_counts = {}
    notebook_updated = {}
    for path_id, count, created_at in session.exec(select(
        NotebookItem.path_id, func.count(NotebookItem.id), func.max(NotebookItem.created_at),
    ).group_by(NotebookItem.path_id)).all():
        notebook_counts[path_id] = count
        notebook_updated[path_id] = created_at
    for model, timestamp, condition in (
        (NotebookPage, NotebookPage.created_at, NotebookPage.path_id.is_not(None)),
        (Activity, Activity.created_at, Activity.kind.startswith("notebook_")),
    ):
        for path_id, updated_at in session.exec(select(model.path_id, func.max(timestamp))
                .where(condition).group_by(model.path_id)).all():
            notebook_updated[path_id] = max(notebook_updated.get(path_id, updated_at), updated_at)
    result = []
    for path in paths:
        count, completed = node_counts.get(path.id, (0, 0))
        period = latest_sessions.get(path.id)
        result.append({
            **path.model_dump(exclude={"generation"}),
            "node_count": count, "completed_count": completed,
            "progress": round(100 * completed / count) if count else 0,
            "resume": {"path_id": path.id, "node_id": period.node_id,
                       "thread_id": period.thread_id} if period else None,
            "last_studied_at": period.last_active_at if period else None,
            "notebook_item_count": notebook_counts.get(path.id, 0),
            "notebook_updated_at": notebook_updated.get(path.id),
        })
    return result


@router.get("/workspace")
def get_workspace(session: Session = Depends(get_session)):
    location = workspace(session)
    paths = list_paths(session)
    path = session.get(LearningPath, location.path_id) if location.path_id else None
    node = session.get(Node, location.node_id) if location.node_id else None
    thread = session.get(Thread, location.thread_id) if location.thread_id else None
    return {"paths": paths, "location": location.model_dump(exclude={"id"}),
            "location_detail": {"path_title": path.title if path else None,
                                "node_title": node.title if node else None,
                                "thread_title": thread.title if thread else None}, "stats": {
        "paths": len(paths), "nodes": sum(path["node_count"] for path in paths),
        "completed": sum(path["completed_count"] for path in paths),
        "notebook_items": session.exec(select(func.count()).select_from(NotebookItem)).one(),
    }}


@router.post("/paths", status_code=201)
def create_path(body: PathInput, session: Session = Depends(get_session)):
    sources = [require(session, Source, source_id) for source_id in set(body.source_ids)]
    if any(source.path_id for source in sources):
        raise HTTPException(409, "Select unattached sources for a new journey.")
    if any(source.status != "ready" for source in sources):
        raise HTTPException(409, "Wait for all selected sources to finish indexing.")
    from pydantic import ValidationError
    try:
        generated = ai.generate_curriculum(session, body.input, body.mode, body.source_ids)
        draft = CurriculumDraft.model_validate(generated)
    except ValidationError as error:
        raise HTTPException(502, "The model returned an invalid curriculum. Please try again.") from error
    for evidence in generated.get("evidence", []):
        source = session.get(Source, evidence.get("source_id"))
        if source and source.path_id is None and source not in sources:
            sources.append(source)
    path = LearningPath(title=draft.title, description=draft.description, input=body.input,
                        generation=generated.get("generation", {}))
    session.add(path)
    session.flush()
    nodes = []
    for position, item in enumerate(draft.nodes):
        node = Node(path_id=path.id, title=item.title, description=item.description,
                    parent_id=nodes[item.parent_index].id if item.parent_index is not None else None,
                    position=position, evidence_ids=item.evidence_ids)
        session.add(node)
        session.flush()
        nodes.append(node)
    for source in sources:
        source.path_id = path.id
        session.add(source)
    activity(session, "path_created", f"Created {path.title}", path_id=path.id)
    session.commit()
    return path_detail(session, path)


@router.get("/paths/{path_id}")
def get_path(path_id: str, session: Session = Depends(get_session)):
    return path_detail(session, require(session, LearningPath, path_id))


@router.patch("/paths/{path_id}")
def edit_path(path_id: str, body: PathEdit, session: Session = Depends(get_session)):
    path = require(session, LearningPath, path_id)
    for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(path, key, value)
    path.updated_at = utcnow()
    session.add(path)
    session.commit()
    return path_detail(session, path)


@router.delete("/paths/{path_id}", status_code=204)
def delete_path(path_id: str, session: Session = Depends(get_session)):
    path = require(session, LearningPath, path_id)
    location = session.get(Workspace, 1)
    if location and location.path_id == path_id:
        location.path_id = location.node_id = location.thread_id = None
        session.add(location)

    export_ids = session.exec(select(ExportRecord.id).where(ExportRecord.path_id == path_id)).all()
    web_ids = session.exec(select(Source.id).where(
        Source.path_id == path_id, Source.kind == "web",
    )).all()
    page_ids = select(NotebookPage.id).where(NotebookPage.path_id == path_id)

    # Remove dependent records before the journey because these tables use restrictive foreign keys.
    session.exec(delete(Activity).where(Activity.path_id == path_id))
    session.exec(delete(ExportRecord).where(ExportRecord.path_id == path_id))
    session.exec(delete(StudySet).where(StudySet.path_id == path_id))
    session.exec(delete(NotebookItem).where(
        (NotebookItem.path_id == path_id) | NotebookItem.page_id.in_(page_ids),
    ))
    session.exec(delete(NotebookPage).where(NotebookPage.path_id == path_id))
    session.exec(delete(LearningSession).where(LearningSession.path_id == path_id))
    session.exec(delete(Interaction).where(Interaction.path_id == path_id))
    session.exec(delete(Thread).where(Thread.path_id == path_id))
    session.exec(delete(Node).where(Node.path_id == path_id))

    # Learner-added material returns to the source library; discovered pages belong to this journey.
    session.exec(update(Source).where(
        Source.path_id == path_id, Source.kind != "web",
    ).values(path_id=None))
    session.exec(delete(Chunk).where(Chunk.source_id.in_(web_ids)))
    session.exec(delete(Source).where(Source.id.in_(web_ids)))
    session.delete(path)
    session.commit()

    for export_id in export_ids:
        try:
            (settings.data_dir / "exports" / f"{export_id}.pdf").unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove PDF export %s after deleting journey %s", export_id, path_id)


@router.post("/paths/{path_id}/nodes", status_code=201)
def add_node(path_id: str, body: NodeInput, session: Session = Depends(get_session)):
    require(session, LearningPath, path_id)
    if body.parent_id:
        parent = require(session, Node, body.parent_id)
        if parent.path_id != path_id:
            raise HTTPException(422, "Parent must belong to this journey.")
        require_available_group(session, parent)
    count = session.exec(select(func.count()).select_from(Node).where(Node.path_id == path_id)).one()
    node = Node(path_id=path_id, position=count, **body.model_dump())
    session.add(node)
    activity(session, "node_added", f"Added {node.title}", path_id=path_id)
    session.commit()
    session.refresh(node)
    return node


@router.patch("/nodes/{node_id}")
def edit_node(node_id: str, body: NodeEdit, session: Session = Depends(get_session)):
    node = require(session, Node, node_id)
    if "parent_id" in body.model_fields_set:
        parent_id = body.parent_id
        while parent_id:
            if parent_id == node.id:
                raise HTTPException(422, "A node cannot be its own ancestor.")
            parent = require(session, Node, parent_id)
            if parent.path_id != node.path_id:
                raise HTTPException(422, "Parent must belong to this journey.")
            if parent_id == body.parent_id and parent_id != node.parent_id:
                require_available_group(session, parent)
            parent_id = parent.parent_id
        node.parent_id = body.parent_id
    for key, value in body.model_dump(exclude_unset=True, exclude_none=True, exclude={"parent_id"}).items():
        setattr(node, key, value)
    session.add(node)
    activity(session, "node_edited", f"Updated {node.title}", node=node)
    session.commit()
    session.refresh(node)
    return node


@router.delete("/nodes/{node_id}", status_code=204)
def delete_node(node_id: str, session: Session = Depends(get_session)):
    node = require(session, Node, node_id)
    has_children = session.exec(select(Node.id).where(Node.parent_id == node_id)).first()
    has_history = session.exec(select(Interaction.id).where(Interaction.node_id == node_id)).first()
    has_threads = session.exec(select(Thread.id).where(Thread.node_id == node_id)).first()
    has_notes = session.exec(select(NotebookItem.id).where(NotebookItem.node_id == node_id)).first()
    if has_children or has_history or has_threads or has_notes or node.status != "not_started":
        raise HTTPException(409, "Only empty, unstarted nodes without children can be removed. Existing learning history is retained.")
    count = session.exec(select(func.count()).select_from(Node).where(Node.path_id == node.path_id)).one()
    if count == 1:
        raise HTTPException(409, "A journey must retain at least one node.")
    location = workspace(session)
    if location.node_id == node.id:
        location.node_id = None
        location.thread_id = None
        session.add(location)
    for event in session.exec(select(Activity).where(Activity.node_id == node.id)).all():
        event.node_id = None
        session.add(event)
    for period in session.exec(select(LearningSession).where(LearningSession.node_id == node.id)).all():
        period.node_id = None
        session.add(period)
    activity(session, "node_removed", f"Removed {node.title}", path_id=node.path_id)
    session.delete(node)
    session.flush()
    nodes = session.exec(select(Node).where(Node.path_id == node.path_id).order_by(Node.position)).all()
    for position, item in enumerate(nodes):
        item.position = position
        session.add(item)
    session.commit()
    return Response(status_code=204)


@router.post("/paths/{path_id}/reorder")
def reorder_nodes(path_id: str, body: ReorderInput, session: Session = Depends(get_session)):
    path = require(session, LearningPath, path_id)
    nodes = session.exec(select(Node).where(Node.path_id == path_id)).all()
    if len(body.node_ids) != len(nodes) or set(body.node_ids) != {node.id for node in nodes}:
        raise HTTPException(422, "Provide every node exactly once when reordering.")
    positions = {node_id: position for position, node_id in enumerate(body.node_ids)}
    for node in nodes:
        node.position = positions[node.id]
        session.add(node)
    activity(session, "path_reordered", f"Reordered {path.title}", path_id=path_id)
    session.commit()
    return path_detail(session, path)


@router.get("/nodes/{node_id}")
def get_node(node_id: str, session: Session = Depends(get_session)):
    node = require(session, Node, node_id)
    require_learning_node(session, node)
    path = path_detail(session, require(session, LearningPath, node.path_id))
    return {"node": node, "path": {key: value for key, value in path.items() if key != "nodes"},
            "nodes": path["nodes"], "threads": session.exec(select(Thread).where(Thread.node_id == node_id)
                .order_by(Thread.created_at)).all(),
            "interactions": session.exec(select(Interaction).where(Interaction.node_id == node_id,
                Interaction.thread_id.is_(None)).order_by(Interaction.created_at)).all()}


@router.patch("/nodes/{node_id}/progress")
def update_progress(node_id: str, body: ProgressInput, session: Session = Depends(get_session)):
    node = require(session, Node, node_id)
    require_learning_node(session, node)
    node.status = body.status
    session.add(node)
    activity(session, "progress", f"{node.title}: {body.status.replace('_', ' ')}", node=node)
    session.commit()
    session.refresh(node)
    return node


def interact(session: Session, node: Node, body: MessageInput, thread: Thread | None = None):
    require_learning_node(session, node)
    if thread and thread.status == "closed":
        raise HTTPException(409, "Reopen this thread before adding a message.")
    context = build_context(session, node, thread)
    context["sources_only"] = body.sources_only
    result = ai.answer(session, context, body.prompt)
    interaction = Interaction(path_id=node.path_id, node_id=node.id,
                              thread_id=thread.id if thread else None, prompt=body.prompt,
                              action=body.action, **result)
    session.add(interaction)
    session.flush()
    # Thread conversations never mutate primary-node progress or location.
    if not thread:
        # Progress may have changed in another request while the answer was generated.
        session.exec(update(Node).where(Node.id == node.id, Node.status == "not_started")
                     .values(status="in_progress"))
    activity(session, "thread_interaction" if thread else "interaction", body.prompt[:160],
             node=node, thread=thread, interaction_id=interaction.id)
    session.commit()
    session.refresh(interaction)
    return interaction


@router.post("/nodes/{node_id}/interactions", status_code=201)
def node_interaction(node_id: str, body: MessageInput, session: Session = Depends(get_session)):
    return interact(session, require(session, Node, node_id), body)


@router.post("/nodes/{node_id}/threads", status_code=201)
def create_thread(node_id: str, body: ThreadInput, session: Session = Depends(get_session)):
    node = require(session, Node, node_id)
    require_learning_node(session, node)
    seed = f"Origin topic: {node.title}. {node.description}"
    if body.interaction_id:
        source = require(session, Interaction, body.interaction_id)
        if source.node_id != node.id or source.thread_id:
            raise HTTPException(422, "Start a thread from a response in this primary node.")
        explanation = source.content if source.status != "abstained" else WITHHELD_ANSWER
        if source.status == "unverified":
            explanation = "General AI knowledge, not verified against sources:\n" + explanation
        seed += f"\nStarting question: {source.prompt}\nStarting explanation: {explanation}"
    thread = Thread(node_id=node.id, path_id=node.path_id, title=body.title, seed_context=seed)
    session.add(thread)
    session.flush()
    activity(session, "thread_created", f"Exploring {thread.title}", node=node, thread=thread)
    session.commit()
    session.refresh(thread)
    return thread


@router.get("/threads/{thread_id}")
def get_thread(thread_id: str, session: Session = Depends(get_session)):
    thread = require(session, Thread, thread_id)
    node = require(session, Node, thread.node_id)
    return {"thread": thread, "node": node, "path": require(session, LearningPath, thread.path_id),
            "interactions": session.exec(select(Interaction).where(Interaction.thread_id == thread_id)
                .order_by(Interaction.created_at)).all()}


@router.patch("/threads/{thread_id}")
def edit_thread(thread_id: str, body: ThreadEdit, session: Session = Depends(get_session)):
    thread = require(session, Thread, thread_id)
    for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(thread, key, value)
    session.add(thread)
    session.commit()
    session.refresh(thread)
    return thread


@router.post("/threads/{thread_id}/interactions", status_code=201)
def thread_interaction(thread_id: str, body: MessageInput, session: Session = Depends(get_session)):
    thread = require(session, Thread, thread_id)
    return interact(session, require(session, Node, thread.node_id), body, thread)


@router.put("/location")
def set_location(body: LocationInput, session: Session = Depends(get_session)):
    location = workspace(session)
    if body.path_id and "node_id" not in body.model_fields_set:
        if location.path_id == body.path_id:
            body.node_id, body.thread_id = location.node_id, location.thread_id
        else:
            previous = session.exec(select(LearningSession).where(
                LearningSession.path_id == body.path_id, LearningSession.node_id.is_not(None),
            ).order_by(LearningSession.last_active_at.desc())).first()
            if previous:
                body.node_id, body.thread_id = previous.node_id, previous.thread_id
    if body.path_id:
        require(session, LearningPath, body.path_id)
    if body.node_id:
        node = require(session, Node, body.node_id)
        if node.path_id != body.path_id:
            raise HTTPException(422, "The node must belong to the selected journey.")
        require_learning_node(session, node)
    if body.thread_id:
        thread = require(session, Thread, body.thread_id)
        if thread.node_id != body.node_id or thread.path_id != body.path_id:
            raise HTTPException(422, "The thread must belong to the selected node.")
    for key, value in body.model_dump().items():
        setattr(location, key, value)
    session.add(location)
    period = session.exec(select(LearningSession).where(LearningSession.ended_at.is_(None))
                          .order_by(LearningSession.started_at.desc())).first()
    if period and (period.path_id != body.path_id or body.node_id is None):
        period.ended_at = utcnow()
        session.add(period)
        period = None
    if body.node_id:
        if period is None:
            period = LearningSession(path_id=body.path_id)
        period.path_id, period.node_id, period.thread_id = body.path_id, body.node_id, body.thread_id
        period.last_active_at = utcnow()
        session.add(period)
    session.commit()
    return body


@router.get("/history")
def history(session: Session = Depends(get_session)):
    return session.exec(select(Activity).order_by(Activity.created_at.desc()).limit(300)).all()


@router.get("/learning-sessions")
def learning_sessions(session: Session = Depends(get_session)):
    periods = session.exec(select(LearningSession).order_by(LearningSession.started_at.desc())).all()
    result = []
    for period in periods:
        path = session.get(LearningPath, period.path_id)
        node = session.get(Node, period.node_id) if period.node_id else None
        thread = session.get(Thread, period.thread_id) if period.thread_id else None
        result.append({**period.model_dump(), "path_title": path.title if path else None,
                       "node_title": node.title if node else None,
                       "thread_title": thread.title if thread else None})
    return result


@router.post("/learning-sessions/end")
def end_learning_session(session: Session = Depends(get_session)):
    period = session.exec(select(LearningSession).where(LearningSession.ended_at.is_(None))
                          .order_by(LearningSession.started_at.desc())).first()
    if period:
        period.ended_at = utcnow()
        period.last_active_at = period.ended_at
        session.add(period)
        session.commit()
        session.refresh(period)
    return period
