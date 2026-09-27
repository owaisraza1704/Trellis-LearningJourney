import json

import pytest
from fastapi import HTTPException
from sqlmodel import select

from trellis import ai, evidence
from trellis.models import LearningPath, Node, Source


CONTEXT = {
    "path_id": "journey", "path_title": "System design", "node_title": "Horizontal scaling",
    "thread_id": "qps-thread", "thread_title": "QPS",
    "history": [{"prompt": "What does QPS measure?", "content": "Queries per second."}],
}
PASSAGE = {
    "id": "passage", "source_id": "source", "title": "Scaling notes", "kind": "text",
    "excerpt": "Horizontal scaling adds more instances.", "location": "Paragraph 1", "url": None,
}


@pytest.fixture
def general_context(monkeypatch):
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(ai, "resolve_question", lambda provider, model, context, prompt: ai.ResolvedQuestion(
        question="Explain queries per second (QPS).", search_query="queries per second QPS",
        sources_only=False,
    ))


@pytest.mark.parametrize("initial_evidence", [[], [PASSAGE]])
def test_missing_evidence_produces_separate_unverified_explanation_after_web_attempt(
    monkeypatch, general_context, initial_evidence,
):
    calls = []
    searches = []
    explanation = "QPS is the number of queries a system processes in one second."

    def retrieve(session, query, **kwargs):
        searches.append((query, kwargs))
        return {"evidence": list(initial_evidence), "warnings": ["Web search found no relevant pages."],
                "web_search_performed": True}

    def complete(provider, model, schema, messages):
        request = json.loads(messages[1]["content"])
        calls.append((schema, request))
        if schema is ai.DraftAnswer:
            return ai.DraftAnswer(status="insufficient", blocks=[],
                                  reason="The retrieved scaling notes do not cover QPS.")
        assert schema is ai.GeneralAnswer
        assert request["question"] == "Explain queries per second (QPS)."
        assert request["context"]["active_topic"] == "QPS"
        assert request["context"]["scope"] == "thread"
        assert "evidence" not in request
        assert "previous_answer" not in request
        assert "evaluation_feedback" not in request
        assert PASSAGE["excerpt"] not in json.dumps(request)
        return ai.GeneralAnswer(can_answer=True, content=explanation, reason="")

    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain more")
    assert result["status"] == "unverified"
    assert explanation in result["content"]
    assert result["evidence"] == []
    assert result["evaluation"]["status"] == "unverified"
    assert result["evaluation"]["method"] == "model_knowledge"
    assert result["evaluation"]["web_search_performed"] is True
    assert result["evaluation"]["retrieval_warnings"] == ["Web search found no relevant pages."]
    assert result["evaluation"]["active_topic"] == "QPS"
    assert len(searches) == 1
    assert [schema for schema, _ in calls] == (
        [ai.DraftAnswer, ai.GeneralAnswer] if initial_evidence else [ai.GeneralAnswer]
    )


def test_sources_only_setting_blocks_fallback_even_if_resolver_allows_it(monkeypatch, general_context):
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": [], "web_search_performed": True,
    })
    monkeypatch.setattr(ai, "structured_completion", lambda *args: pytest.fail("No general answer allowed"))
    result = ai.answer(None, {**CONTEXT, "sources_only": True}, "Explain more")
    assert result["status"] == "abstained"
    assert result["evaluation"]["status"] == "evidence_unavailable"


@pytest.mark.parametrize("generated", [
    "QPS means queries per second. [1]",
    "QPS means queries per second. See https://invented.example/qps.",
    "QPS means queries per second. [Documentation](https://invented.example/qps)",
])
def test_general_explanation_cannot_invent_source_references(monkeypatch, general_context, generated):
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": [], "web_search_performed": True,
    })
    monkeypatch.setattr(ai, "structured_completion", lambda *args: ai.GeneralAnswer(
        can_answer=True, content=generated, reason="",
    ))
    result = ai.answer(None, CONTEXT, "Explain more")
    assert result["status"] == "abstained"
    assert "invented.example" not in result["content"]
    assert "[1]" not in result["content"]
    assert result["evidence"] == []


def test_general_explanation_can_include_code_without_treating_it_as_a_citation(
    monkeypatch, general_context,
):
    content = "Access the second item with `samples[1]`.\n\n```python\nprint(samples[1])\n```"
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": [], "web_search_performed": True,
    })
    monkeypatch.setattr(ai, "structured_completion", lambda *args: ai.GeneralAnswer(
        can_answer=True, content=content, reason="",
    ))
    result = ai.answer(None, CONTEXT, "Explain the QPS samples in this example")
    assert result["status"] == "unverified"
    assert result["content"] == content
    assert result["evidence"] == []


def test_general_model_can_decline_a_document_specific_question(monkeypatch, general_context):
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": [], "web_search_performed": True,
    })
    monkeypatch.setattr(ai, "structured_completion", lambda *args: ai.GeneralAnswer(
        can_answer=False, content="Do not show an invented description of the uploaded document.",
        reason="The requested document contents are unavailable.",
    ))
    result = ai.answer(None, CONTEXT, "What QPS limit does my uploaded report specify?")
    assert result["status"] == "abstained"
    assert "invented description" not in result["content"]


def test_general_provider_failure_reports_generation_unavailable(monkeypatch, general_context):
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": [], "web_search_performed": True,
    })

    def complete(provider, model, schema, messages):
        assert schema is ai.GeneralAnswer
        raise HTTPException(503, "Provider failure with private endpoint details.")

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain more")
    assert result["status"] == "abstained"
    assert result["evaluation"]["status"] == "general_knowledge_failed"
    assert result["content"] == (
        "I couldn't generate a general explanation. Please try again or check the model connection in Settings."
    )
    assert "private endpoint" not in result["content"]
    assert result["evidence"] == []


@pytest.mark.parametrize("failure", ["unsupported", "invalid_citations", "evaluation_outage"])
def test_failed_source_checks_never_show_the_rejected_draft(
    monkeypatch, general_context, failure,
):
    calls = []
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [PASSAGE], "warnings": [], "web_search_performed": False,
    })

    def complete(provider, model, schema, messages):
        calls.append(schema)
        if schema is ai.GeneralAnswer:
            request = json.loads(messages[1]["content"])
            assert "evidence" not in request
            assert "previous_answer" not in request
            return ai.GeneralAnswer(
                can_answer=True, content="QPS counts queries processed each second.", reason="",
            )
        if schema is ai.DraftAnswer:
            return ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
                text="Horizontal scaling always guarantees unlimited QPS.",
                evidence_ids=["invented"] if failure == "invalid_citations" else [PASSAGE["id"]],
            )])
        assert schema is ai.AnswerEvaluation
        if failure == "evaluation_outage":
            raise HTTPException(503, "Evaluation temporarily unavailable.")
        return ai.AnswerEvaluation(
            relevance=1, completeness=1, consistency=0, grounding=0, supported=False,
            explanation="The unlimited capacity claim is unsupported by the source.",
        )

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain more")
    assert "guarantees unlimited QPS" not in result["content"]
    expected_status = {"unsupported": "low_grounding", "invalid_citations": "invalid_citations",
                       "evaluation_outage": "evaluation_failed"}[failure]
    if failure == "evaluation_outage":
        assert result["status"] == "abstained"
        assert result["evaluation"]["status"] == expected_status
        assert ai.GeneralAnswer not in calls
    else:
        assert result["status"] == "unverified"
        assert result["evaluation"]["fallback_reason"] == expected_status
        assert result["evidence"] == []
        assert calls[-1] is ai.GeneralAnswer


def test_correction_declaring_insufficiency_does_not_bypass_a_failed_grounding_check(
    monkeypatch, general_context,
):
    outputs = iter([
        ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
            text="Horizontal scaling guarantees unlimited capacity.", evidence_ids=[PASSAGE["id"]],
        )]),
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=0, grounding=0,
                            supported=False, explanation="The claim is unsupported."),
        ai.DraftAnswer(status="insufficient", blocks=[], reason="The capacity claim cannot be supported."),
    ])
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [PASSAGE], "warnings": [], "web_search_performed": False,
    })

    def complete(provider, model, schema, messages):
        if schema is ai.GeneralAnswer:
            return ai.GeneralAnswer(
                can_answer=True, content="QPS measures queries handled in one second.", reason="",
            )
        return next(outputs)

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain more")
    assert result["status"] == "unverified"
    assert "unlimited capacity" not in result["content"]
    assert result["evaluation"]["fallback_reason"] == "insufficient_evidence"
    assert result["evaluation"]["correction_attempted"] is True


def test_sources_only_api_choice_is_preserved_for_each_request(client, session, monkeypatch):
    path = LearningPath(title="QPS learning", input="Learn QPS")
    session.add(path)
    session.commit()
    node = Node(path_id=path.id, title="QPS")
    session.add(node)
    session.commit()
    node_id = node.id
    seen = []

    def complete(provider, model, schema, messages):
        if schema is ai.GeneralAnswer:
            assert len(seen) == 2
            return ai.GeneralAnswer(can_answer=True, content="QPS measures queries per second.", reason="")
        assert schema is ai.ResolvedQuestion
        request = json.loads(messages[1]["content"])
        seen.append(request)
        if len(seen) == 1:
            assert request["context"]["sources_only"] is True
        else:
            assert request["context"]["sources_only"] is False
            assert request["context"]["history"][0]["sources_only"] is True
        return ai.ResolvedQuestion(question="Explain QPS.", search_query="QPS", sources_only=False)

    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(ai, "structured_completion", complete)
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": [], "web_search_performed": True,
    })
    response = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Explain QPS", "sources_only": True,
    })
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "abstained"
    assert len(seen) == 1
    relaxed = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Explain more", "sources_only": False,
    })
    assert relaxed.status_code == 201, relaxed.text
    assert relaxed.json()["status"] == "unverified"
    assert relaxed.json()["evaluation"]["sources_only"] is False
    assert len(seen) == 2


def test_general_response_persists_without_creating_a_source(client, session, monkeypatch, general_context):
    path = LearningPath(title="QPS learning", input="Learn QPS")
    session.add(path)
    session.commit()
    node = Node(path_id=path.id, title="QPS")
    session.add(node)
    session.commit()
    node_id = node.id
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": ["No relevant web sources found."], "web_search_performed": True,
    })
    monkeypatch.setattr(ai, "structured_completion", lambda *args: ai.GeneralAnswer(
        can_answer=True, content="QPS measures queries per second.", reason="",
    ))
    response = client.post(f"/api/nodes/{node_id}/interactions", json={"prompt": "Explain QPS"})
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["status"] == "unverified"
    assert result["evidence"] == []
    saved = client.get(f"/api/nodes/{node_id}").json()["interactions"][0]
    assert saved["id"] == result["id"]
    assert saved["evaluation"]["method"] == "model_knowledge"
    assert saved["evaluation"]["status"] == "unverified"
    assert session.exec(select(Source)).all() == []
