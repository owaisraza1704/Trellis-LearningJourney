from copy import deepcopy
from html import escape
import logging
from pathlib import Path
import re
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from markdown_it import MarkdownIt
from pydantic import BaseModel, ConfigDict, Field
from reportlab import rl_config
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    CondPageBreak,
    HRFlowable,
    ListFlowable,
    ListItem,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlmodel import Session, select

from .config import settings
from .core import activity
from .db import get_session
from .models import (
    ExportRecord,
    Interaction,
    LearningPath,
    Node,
    NotebookItem,
    NotebookPage,
    StudySet,
    Thread,
)

router = APIRouter()
Database = Annotated[Session, Depends(get_session)]
logger = logging.getLogger(__name__)


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class PageCreate(Input):
    path_id: str
    title: str = Field(min_length=1, max_length=200)


class PageUpdate(Input):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    position: int | None = Field(default=None, ge=0)


class ItemCreate(Input):
    page_id: str
    interaction_id: str | None = None
    content: str | None = Field(default=None, min_length=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    node_id: str | None = None
    thread_id: str | None = None
    evidence_id: str | None = None


class ItemUpdate(Input):
    page_id: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1)
    position: int | None = Field(default=None, ge=0)


class ItemOrder(Input):
    item_ids: list[str]


class StudyCreate(Input):
    path_id: str
    title: str = Field(min_length=1, max_length=200)
    item_ids: list[str] = Field(default_factory=list)


class StudyUpdate(Input):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    item_ids: list[str] | None = None


class ExportCreate(StudyCreate):
    study_session_id: str | None = None


def require_record(session: Session, model: type, record_id: str):
    record = session.get(model, record_id)
    if record is None:
        raise HTTPException(404, f"{model.__name__} was not found.")
    return record


def page_items(session: Session, page_id: str) -> list[NotebookItem]:
    return list(session.exec(
        select(NotebookItem)
        .where(NotebookItem.page_id == page_id)
        .order_by(NotebookItem.position, NotebookItem.created_at)
    ).all())


def assigned_path(record) -> str:
    if record.path_id is None:
        raise HTTPException(409, "This legacy notebook material is unassigned and read-only.")
    return record.path_id


def selected_items(session: Session, item_ids: list[str], path_id: str) -> list[NotebookItem]:
    if len(item_ids) != len(set(item_ids)):
        raise HTTPException(422, "Select each notebook item only once.")
    items = [require_record(session, NotebookItem, item_id) for item_id in item_ids]
    for item in items:
        page = require_record(session, NotebookPage, item.page_id)
        if item.path_id != path_id or page.path_id != path_id:
            raise HTTPException(422, "Select material only from this journey's notebook.")
    return items


@router.get("/notebook/pages")
def list_pages(session: Database, path_id: str | None = None):
    statement = select(NotebookPage).order_by(NotebookPage.position, NotebookPage.created_at)
    if path_id is not None:
        require_record(session, LearningPath, path_id)
        statement = statement.where(NotebookPage.path_id == path_id)
    pages = session.exec(statement).all()
    return [{**page.model_dump(), "items": page_items(session, page.id)} for page in pages]


@router.post("/notebook/pages", status_code=201)
def create_page(body: PageCreate, session: Database):
    require_record(session, LearningPath, body.path_id)
    pages = session.exec(select(NotebookPage).where(NotebookPage.path_id == body.path_id)).all()
    page = NotebookPage(path_id=body.path_id, title=body.title, position=len(pages))
    session.add(page)
    activity(session, "notebook_updated", f"Created notebook section {page.title}", path_id=body.path_id)
    session.commit()
    session.refresh(page)
    return {**page.model_dump(), "items": []}


@router.patch("/notebook/pages/{page_id}")
def update_page(page_id: str, body: PageUpdate, session: Database):
    page = require_record(session, NotebookPage, page_id)
    path_id = assigned_path(page)
    if body.title is not None:
        page.title = body.title
    if body.position is not None:
        pages = list(session.exec(
            select(NotebookPage).where(NotebookPage.path_id == path_id)
            .order_by(NotebookPage.position, NotebookPage.created_at)
        ).all())
        if body.position >= len(pages):
            raise HTTPException(422, "Page position must be within the notebook.")
        pages.remove(page)
        pages.insert(body.position, page)
        for index, entry in enumerate(pages):
            entry.position = index
            session.add(entry)
    session.add(page)
    activity(session, "notebook_updated", f"Updated notebook section {page.title}", path_id=path_id)
    session.commit()
    session.refresh(page)
    return {**page.model_dump(), "items": page_items(session, page.id)}


@router.delete("/notebook/pages/{page_id}", status_code=204)
def delete_page(page_id: str, session: Database):
    page = require_record(session, NotebookPage, page_id)
    path_id = assigned_path(page)
    if page_items(session, page.id):
        raise HTTPException(409, "Move or remove this section's notes before deleting it.")
    session.delete(page)
    session.flush()
    pages = session.exec(
        select(NotebookPage).where(NotebookPage.path_id == path_id)
        .order_by(NotebookPage.position, NotebookPage.created_at)
    ).all()
    for index, entry in enumerate(pages):
        entry.position = index
        session.add(entry)
    activity(session, "notebook_updated", f"Removed notebook section {page.title}", path_id=path_id)
    session.commit()


@router.post("/notebook/items", status_code=201)
def create_item(body: ItemCreate, session: Database):
    page = require_record(session, NotebookPage, body.page_id)
    path = require_record(session, LearningPath, assigned_path(page))
    origin: dict[str, Any] = {"path_id": path.id, "path_title": path.title}
    evidence: list[dict[str, Any]] = []
    interaction = None
    node = None
    thread = None
    kind = "note"
    content = body.content
    title = body.title

    if body.interaction_id:
        interaction = require_record(session, Interaction, body.interaction_id)
        if interaction.path_id != path.id:
            raise HTTPException(422, "Save this response in its own journey's notebook.")
        if interaction.status == "abstained" and not body.evidence_id:
            raise HTTPException(422, "This answer was withheld. Save a source excerpt or write a personal note instead.")
        if body.node_id and body.node_id != interaction.node_id:
            raise HTTPException(422, "The saved response belongs to a different node.")
        if body.thread_id and body.thread_id != interaction.thread_id:
            raise HTTPException(422, "The saved response belongs to a different thread.")
        node = require_record(session, Node, interaction.node_id)
        if interaction.thread_id:
            thread = require_record(session, Thread, interaction.thread_id)
        kind = "response"
        content = content or interaction.content
        title = title or interaction.prompt[:200]
        evidence = deepcopy(interaction.evidence)
        origin = interaction.model_dump(mode="json")
        origin["interaction_id"] = interaction.id
        if body.evidence_id:
            evidence = [entry for entry in evidence if entry.get("id") == body.evidence_id]
            if not evidence or not evidence[0].get("excerpt"):
                raise HTTPException(422, "That evidence excerpt is not part of this response.")
            kind = "evidence"
            content = evidence[0]["excerpt"]
            title = body.title or evidence[0].get("title") or "Evidence excerpt"
            origin["evidence_id"] = body.evidence_id
    else:
        if body.evidence_id:
            raise HTTPException(422, "Saving evidence requires its originating response.")
        if body.thread_id:
            thread = require_record(session, Thread, body.thread_id)
            if body.node_id and body.node_id != thread.node_id:
                raise HTTPException(422, "The thread belongs to a different node.")
            node = require_record(session, Node, thread.node_id)
        elif body.node_id:
            node = require_record(session, Node, body.node_id)

    if not content or not content.strip():
        raise HTTPException(422, "A notebook item needs some content.")
    if node:
        if node.path_id != path.id:
            raise HTTPException(422, "The note's node belongs to another journey's notebook.")
        if thread and (thread.node_id != node.id or thread.path_id != path.id):
            raise HTTPException(422, "The thread and node must belong to the same path.")
        if interaction and interaction.path_id != path.id:
            raise HTTPException(422, "The response and node must belong to the same path.")
        origin.update(path_id=path.id, path_title=path.title, node_id=node.id, node_title=node.title)
    if thread:
        origin.update(thread_id=thread.id, thread_title=thread.title)
    item = NotebookItem(
        page_id=body.page_id,
        title=title or "Personal note",
        content=content,
        kind=kind,
        position=len(page_items(session, body.page_id)),
        path_id=path.id,
        node_id=node.id if node else None,
        thread_id=thread.id if thread else None,
        interaction_id=interaction.id if interaction else None,
        origin=origin,
        evidence=evidence,
    )
    session.add(item)
    session.flush()
    activity(session, "notebook_saved", f"Saved {item.title} to notebook",
             node=node, thread=thread, path_id=path.id,
             interaction_id=interaction.id if interaction else None, notebook_item_id=item.id)
    session.commit()
    session.refresh(item)
    return item


@router.patch("/notebook/items/{item_id}")
def update_item(item_id: str, body: ItemUpdate, session: Database):
    item = require_record(session, NotebookItem, item_id)
    source_page = require_record(session, NotebookPage, item.page_id)
    path_id = assigned_path(source_page)
    if assigned_path(item) != path_id:
        raise HTTPException(409, "This note's journey ownership is inconsistent; it is read-only.")
    target_page = body.page_id or item.page_id
    destination_page = require_record(session, NotebookPage, target_page)
    if assigned_path(destination_page) != path_id:
        raise HTTPException(422, "Move notes only between sections of the same journey's notebook.")
    old_items = page_items(session, item.page_id)
    destination = old_items if target_page == item.page_id else page_items(session, target_page)
    destination = [entry for entry in destination if entry.id != item.id]
    if body.position is not None and body.position > len(destination):
        raise HTTPException(422, "Note position must be within the destination section.")
    if body.position is not None or target_page != item.page_id:
        if target_page != item.page_id:
            for index, entry in enumerate(entry for entry in old_items if entry.id != item.id):
                entry.position = index
                session.add(entry)
        destination.insert(body.position if body.position is not None else len(destination), item)
        for index, entry in enumerate(destination):
            entry.position = index
            session.add(entry)
        item.page_id = target_page
    if body.title is not None:
        item.title = body.title
    if body.content is not None:
        item.content = body.content
    session.add(item)
    activity(session, "notebook_updated", f"Updated notebook note {item.title}",
             path_id=path_id, notebook_item_id=item.id)
    session.commit()
    session.refresh(item)
    return item


@router.post("/notebook/pages/{page_id}/reorder")
def reorder_items(page_id: str, body: ItemOrder, session: Database):
    page = require_record(session, NotebookPage, page_id)
    path_id = assigned_path(page)
    items = page_items(session, page_id)
    if len(body.item_ids) != len(items) or set(body.item_ids) != {item.id for item in items}:
        raise HTTPException(422, "Provide every note in this section exactly once.")
    by_id = {item.id: item for item in items}
    for index, item_id in enumerate(body.item_ids):
        by_id[item_id].position = index
        session.add(by_id[item_id])
    activity(session, "notebook_updated", f"Reordered notes in {page.title}", path_id=path_id)
    session.commit()
    return {**page.model_dump(), "items": page_items(session, page_id)}


@router.delete("/notebook/items/{item_id}", status_code=204)
def delete_item(item_id: str, session: Database):
    item = require_record(session, NotebookItem, item_id)
    page = require_record(session, NotebookPage, item.page_id)
    if assigned_path(item) != assigned_path(page):
        raise HTTPException(409, "This note's journey ownership is inconsistent; it is read-only.")
    remaining = [entry for entry in page_items(session, item.page_id) if entry.id != item.id]
    for index, entry in enumerate(remaining):
        entry.position = index
        session.add(entry)
    for study in session.exec(select(StudySet).where(StudySet.path_id == item.path_id)).all():
        if item.id in study.item_ids:
            study.item_ids = [saved_id for saved_id in study.item_ids if saved_id != item.id]
            session.add(study)
    activity(session, "notebook_updated", f"Removed notebook note {item.title}", path_id=item.path_id)
    session.delete(item)
    session.commit()


@router.get("/study-sessions")
def list_studies(session: Database, path_id: str | None = None):
    statement = select(StudySet).order_by(StudySet.created_at.desc())
    if path_id is not None:
        require_record(session, LearningPath, path_id)
        statement = statement.where(StudySet.path_id == path_id)
    return session.exec(statement).all()


@router.post("/study-sessions", status_code=201)
def create_study(body: StudyCreate, session: Database):
    require_record(session, LearningPath, body.path_id)
    selected_items(session, body.item_ids, body.path_id)
    study = StudySet(path_id=body.path_id, title=body.title, item_ids=body.item_ids)
    session.add(study)
    session.commit()
    session.refresh(study)
    return study


@router.patch("/study-sessions/{study_id}")
def update_study(study_id: str, body: StudyUpdate, session: Database):
    study = require_record(session, StudySet, study_id)
    path_id = assigned_path(study)
    if body.item_ids is not None:
        selected_items(session, body.item_ids, path_id)
        study.item_ids = body.item_ids
    if body.title is not None:
        study.title = body.title
    session.add(study)
    session.commit()
    session.refresh(study)
    return study


def export_metadata(record: ExportRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "path_id": record.path_id,
        "title": record.title,
        "status": record.status,
        "error": record.error,
        "created_at": record.created_at,
        "study_session_id": record.study_session_id,
        "item_ids": [item["id"] for item in record.snapshot],
        "item_count": len(record.snapshot),
        "download_url": f"/api/exports/{record.id}/download" if record.status == "completed" else None,
    }


@router.get("/exports")
def list_exports(session: Database, path_id: str | None = None):
    statement = select(ExportRecord).order_by(ExportRecord.created_at.desc())
    if path_id is not None:
        require_record(session, LearningPath, path_id)
        statement = statement.where(ExportRecord.path_id == path_id)
    records = session.exec(statement).all()
    return [export_metadata(record) for record in records]


@router.post("/exports", status_code=201)
def create_export(body: ExportCreate, session: Database):
    require_record(session, LearningPath, body.path_id)
    if not body.item_ids:
        raise HTTPException(422, "Select at least one notebook item to export.")
    items = selected_items(session, body.item_ids, body.path_id)
    if body.study_session_id:
        study = require_record(session, StudySet, body.study_session_id)
        if assigned_path(study) != body.path_id:
            raise HTTPException(422, "Use a study session from this journey's notebook.")
        if any(item_id not in study.item_ids for item_id in body.item_ids):
            raise HTTPException(422, "Export items must belong to the selected study session.")
    record = ExportRecord(
        path_id=body.path_id,
        title=body.title,
        study_session_id=body.study_session_id,
        snapshot=[deepcopy(item.model_dump(mode="json")) for item in items],
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    relative_path = Path("exports") / f"{record.id}.pdf"
    output = settings.data_dir / relative_path
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        render_pdf(record, output)
        record.status = "completed"
        record.file_path = relative_path.as_posix()
    except Exception:
        logger.exception("PDF export %s failed", record.id)
        record.status = "failed"
        record.error = "PDF generation failed. Your notes and selection are safe; try exporting again."
        try:
            output.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove incomplete PDF for export %s", record.id)
    session.add(record)
    session.commit()
    session.refresh(record)
    return export_metadata(record)


@router.get("/exports/{export_id}")
def get_export(export_id: str, session: Database):
    return export_metadata(require_record(session, ExportRecord, export_id))


@router.get("/exports/{export_id}/download")
def download_export(export_id: str, session: Database):
    record = require_record(session, ExportRecord, export_id)
    if record.status != "completed":
        raise HTTPException(409, "This PDF is not available. Check its export status.")
    filename = f"{record.id}.pdf"
    recorded_path = Path(record.file_path or "")
    relative_path = Path("exports") / filename
    legacy_path = (recorded_path.is_absolute() and recorded_path.name == filename
                   and recorded_path.parent.name == "exports")
    directory = (settings.data_dir / "exports").resolve()
    expected_path = (directory / filename).resolve()
    if (recorded_path != relative_path and not legacy_path
            or expected_path.parent != directory or not expected_path.is_file()):
        raise HTTPException(404, "The exported PDF is missing. Create a new export from your notebook.")
    return FileResponse(expected_path, media_type="application/pdf", filename=f"trellis-{record.id}.pdf")


def pdf_styles():
    # Prefer installed Unicode fonts; ReportLab's bundled Vera keeps exports portable.
    families = [
        (Path("/System/Library/Fonts/Supplemental"),
         ("Arial Unicode.ttf", "Arial Bold.ttf", "Arial Italic.ttf", "Arial Bold Italic.ttf")),
        (Path("/usr/share/fonts/truetype/dejavu"),
         ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf")),
        *((Path(directory), ("Vera.ttf", "VeraBd.ttf", "VeraIt.ttf", "VeraBI.ttf"))
          for directory in rl_config.TTFSearchPath),
    ]
    font_dir, filenames = next((directory, files) for directory, files in families
                               if all((directory / filename).exists() for filename in files))
    for name, filename in zip(
        ("Trellis", "Trellis-Bold", "Trellis-Italic", "Trellis-BoldItalic"), filenames,
    ):
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(font_dir / filename)))
    code_font = next((path for path in (
        Path("/System/Library/Fonts/Supplemental/Courier New.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    ) if path.exists()), None)
    if code_font and "Trellis-Code" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("Trellis-Code", str(code_font)))
    pdfmetrics.registerFontFamily(
        "Trellis", normal="Trellis", bold="Trellis-Bold", italic="Trellis-Italic",
        boldItalic="Trellis-BoldItalic",
    )
    styles = getSampleStyleSheet()
    for style in styles.byName.values():
        style.fontName = "Trellis"
        style.textColor = colors.HexColor("#263a35")
    styles["BodyText"].fontSize = 9
    styles["BodyText"].leading = 14
    styles["BodyText"].spaceAfter = 8
    styles["BodyText"].splitLongWords = True
    styles["Title"].fontName = "Trellis-Bold"
    styles["Title"].fontSize = 24
    styles["Title"].leading = 31
    styles["Title"].alignment = TA_LEFT
    styles["Title"].spaceAfter = 12
    for level in range(1, 7):
        styles[f"Heading{level}"].fontName = "Trellis-Bold"
        styles[f"Heading{level}"].spaceBefore = 12
        styles[f"Heading{level}"].spaceAfter = 7
    styles.add(ParagraphStyle(
        "Context", parent=styles["BodyText"], fontSize=8, leading=12,
        textColor=colors.HexColor("#62776e"), spaceAfter=10,
    ))
    styles.add(ParagraphStyle(
        "Source", parent=styles["Context"], fontSize=7.5, leading=11, spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        "CodeBlock", fontName="Trellis-Code" if code_font else "Courier", fontSize=8, leading=11,
        backColor=colors.HexColor("#f2f4ee"), borderPadding=7,
        spaceBefore=6, spaceAfter=10,
    ))
    styles.add(ParagraphStyle(
        "Quote", parent=styles["BodyText"], leftIndent=14,
        textColor=colors.HexColor("#62776e"),
    ))
    return styles


def inline_markup(tokens) -> str:
    output = []
    link_open = False
    for token in tokens or []:
        if token.type == "text":
            output.append(escape(token.content))
        elif token.type == "code_inline":
            code_font = "Trellis-Code" if "Trellis-Code" in pdfmetrics.getRegisteredFontNames() else "Courier"
            output.append(f'<font name="{code_font}">{escape(token.content)}</font>')
        elif token.type in {"softbreak", "hardbreak"}:
            output.append("<br/>" if token.type == "hardbreak" else " ")
        elif token.type in {"strong_open", "strong_close", "em_open", "em_close"}:
            output.append({"strong_open": "<b>", "strong_close": "</b>",
                           "em_open": "<i>", "em_close": "</i>"}[token.type])
        elif token.type == "link_open":
            href = token.attrGet("href") or ""
            link_open = urlsplit(href).scheme in {"https", "http", "mailto"}
            if link_open:
                output.append(f'<link href="{escape(href, quote=True)}" color="#475b95">')
        elif token.type == "link_close":
            if link_open:
                output.append("</link>")
            link_open = False
        elif token.type == "image":
            output.append(f'[Image: {escape(token.content or "illustration")}]')
        elif token.content:
            output.append(escape(token.content))
    return "".join(output)


def markdown_flowables(content: str, styles, width: float):
    tokens = MarkdownIt("commonmark", {"html": False}).enable("table").parse(content)

    def blocks(index: int, closing: str | None = None, quoted: bool = False):
        flowables = []
        while index < len(tokens):
            token = tokens[index]
            if token.type == closing:
                return flowables, index + 1
            if token.type in {"heading_open", "paragraph_open"}:
                style = styles[f"Heading{token.tag[1]}"] if token.type == "heading_open" else (
                    styles["Quote"] if quoted else styles["BodyText"]
                )
                flowables.append(Paragraph(inline_markup(tokens[index + 1].children), style))
                index += 3
                continue
            if token.type in {"fence", "code_block"}:
                # ReportLab wraps oversized code lines while retaining indentation and line breaks.
                flowables.append(Preformatted(
                    token.content.rstrip(), styles["CodeBlock"],
                    maxLineLength=max(35, int(width / 4.8) - 8), splitChars=" ,", newLineChars="  ",
                ))
            elif token.type in {"bullet_list_open", "ordered_list_open"}:
                ordered = token.type == "ordered_list_open"
                end = "ordered_list_close" if ordered else "bullet_list_close"
                entries = []
                index += 1
                while index < len(tokens) and tokens[index].type != end:
                    if tokens[index].type == "list_item_open":
                        children, index = blocks(index + 1, "list_item_close", quoted)
                        entries.append(ListItem(children))
                    else:
                        index += 1
                flowables.append(ListFlowable(
                    entries, bulletType="1" if ordered else "bullet", leftIndent=17,
                    bulletFontName="Trellis", bulletFontSize=8,
                    start=int(token.attrGet("start") or 1) if ordered else None,
                    spaceAfter=7,
                ))
            elif token.type == "blockquote_open":
                children, index = blocks(index + 1, "blockquote_close", True)
                flowables.extend(children)
                continue
            elif token.type == "table_open":
                rows = []
                row = []
                index += 1
                while index < len(tokens) and tokens[index].type != "table_close":
                    if tokens[index].type == "tr_open":
                        row = []
                    elif tokens[index].type == "inline":
                        row.append(Paragraph(inline_markup(tokens[index].children), styles["BodyText"]))
                    elif tokens[index].type == "tr_close":
                        rows.append(row)
                    index += 1
                if rows:
                    table = Table(rows, colWidths=[width / len(rows[0])] * len(rows[0]),
                                  repeatRows=1, hAlign="LEFT", splitInRow=1)
                    table.setStyle(TableStyle([
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e3ebdf")),
                        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c8d3c2")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 7),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                        ("TOPPADDING", (0, 0), (-1, -1), 7),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ]))
                    flowables.extend([table, Spacer(1, 9)])
            elif token.type == "hr":
                flowables.append(HRFlowable(width="100%", color=colors.HexColor("#d8e0d3")))
            elif token.content:
                flowables.append(Paragraph(escape(token.content), styles["BodyText"]))
            index += 1
        return flowables, index

    return blocks(0)[0]


def repair_cited_fences(content: str) -> str:
    """Repair old generated fence endings for display without changing stored notes."""
    lines = []
    fence = ""
    for line in content.splitlines():
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if match:
            marker, suffix = match.groups()
            if not fence and (marker[0] != "`" or "`" not in suffix):
                fence = marker
            elif fence and marker[0] == fence[0] and len(marker) >= len(fence):
                if re.fullmatch(r"\s*(?:\[\d+\]\s*)+", suffix):
                    lines.extend([line[:len(line) - len(suffix)], "", suffix.strip()])
                    fence = ""
                    continue
                if not suffix.strip():
                    fence = ""
        lines.append(line)
    return "\n".join(lines)


def render_pdf(record: ExportRecord, output: Path) -> None:
    styles = pdf_styles()
    document = SimpleDocTemplate(
        str(output), pagesize=A4, rightMargin=20 * mm, leftMargin=20 * mm,
        topMargin=23 * mm, bottomMargin=21 * mm, title=record.title, author="Trellis",
    )
    story = [
        Paragraph(escape(record.title), styles["Title"]),
        Paragraph(
            f'{len(record.snapshot)} selected items · Exported '
            f'{record.created_at.strftime("%d %b %Y, %H:%M UTC")}', styles["Context"],
        ),
        HRFlowable(width="100%", color=colors.HexColor("#c8d3c2"), spaceAfter=14),
    ]
    for index, item in enumerate(record.snapshot, start=1):
        origin = item.get("origin", {})
        story.append(CondPageBreak(55 * mm))
        story.append(Paragraph(f'{index}. {escape(item["title"])}', styles["Heading1"]))
        context = [label + ": " + str(origin[key]) for key, label in (
            ("path_title", "Learning path"), ("node_title", "Node"), ("thread_title", "Exploration"),
        ) if origin.get(key)]
        context.append("Personal note" if item["kind"] == "note" else (
            "Evidence excerpt" if item["kind"] == "evidence" else "Saved response"
        ))
        story.append(Paragraph("<br/>".join(escape(part) for part in context), styles["Context"]))
        if item["kind"] == "response" and origin.get("status") == "unverified":
            story.append(Paragraph(
                "<b>General AI knowledge — not verified against sources</b><br/>"
                "I could not verify an answer against the available sources. This explanation uses the "
                "model’s general knowledge and may contain inaccuracies.",
                styles["Context"],
            ))
        content = repair_cited_fences(item["content"]) if item["kind"] == "response" else item["content"]
        story.extend(markdown_flowables(content, styles, document.width))
        if item.get("evidence"):
            story.append(Paragraph("Sources", styles["Heading3"]))
            for reference, evidence in enumerate(item["evidence"], start=1):
                label = f'[{reference}] ' + str(evidence.get("title") or "Source")
                if evidence.get("location"):
                    label += " - " + str(evidence["location"])
                source = escape(label)
                if evidence.get("url"):
                    url = str(evidence["url"])
                    if urlsplit(url).scheme in {"https", "http"}:
                        source += f'<br/><link href="{escape(url, quote=True)}" color="#475b95">{escape(url)}</link>'
                    else:
                        source += "<br/>" + escape(url)
                story.append(Paragraph(source, styles["Source"]))
        story.append(Spacer(1, 12))

    def page_frame(canvas, doc):
        canvas.saveState()
        canvas.setFont("Trellis-Bold", 8)
        canvas.setFillColor(colors.HexColor("#62776e"))
        canvas.drawString(20 * mm, A4[1] - 14 * mm, "TRELLIS / STUDY NOTES")
        canvas.setFont("Trellis", 8)
        canvas.drawString(20 * mm, 12 * mm, "Your selected learning material")
        canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, str(doc.page))
        canvas.restoreState()

    document.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
