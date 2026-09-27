import copy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import Session, SQLModel

from trellis.db import engine, get_session
from trellis import models  # noqa: F401


@pytest.fixture
def db_engine():
    # Every test gets a new schema; the learner's public-schema data is untouched.
    schema = "test_" + uuid4().hex
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    test_engine = engine.execution_options(schema_translate_map={None: schema})
    SQLModel.metadata.create_all(test_engine)
    try:
        yield test_engine
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))


@pytest.fixture
def session(db_engine):
    with Session(db_engine) as session:
        yield session


@pytest.fixture
def client(session, db_engine, tmp_path, monkeypatch):
    from trellis.main import app
    from trellis.config import settings
    from trellis import evidence
    from trellis import main
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(evidence, "engine", db_engine)
    monkeypatch.setattr(main, "engine", db_engine)
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app, raise_server_exceptions=True) as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def stub_ai(monkeypatch):
    from trellis import ai
    contexts = []

    def curriculum(session, input, mode, source_ids):
        return {"title": input, "description": "A fixture curriculum", "nodes": [
            {"title": "Foundations", "description": "Start here", "parent_index": None},
            {"title": "Sequences", "description": "Lists and tuples", "parent_index": None},
            {"title": "Mappings", "description": "Dictionaries", "parent_index": None},
        ]}

    def answer(session, context, prompt):
        contexts.append(copy.deepcopy(context))
        return {"content": "A fixture explanation about " + context["node_title"],
                "status": "answered", "evidence": [], "evaluation": {"status": "test_fixture"},
                "provider": "fixture", "model": "fixture"}

    monkeypatch.setattr(ai, "generate_curriculum", curriculum)
    monkeypatch.setattr(ai, "answer", answer)
    return contexts
