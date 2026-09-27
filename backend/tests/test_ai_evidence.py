import io
import json
import shutil
import socket
from pathlib import Path

import httpx
import openai
import pytest
from fastapi import HTTPException
from markdown_it import MarkdownIt
from reportlab.pdfgen import canvas
from sqlmodel import select

from trellis import ai, evidence
from trellis.models import Chunk, LearningPath, Source


EVIDENCE = {
    "id": "chunk-one", "source_id": "source-one", "title": "Python documentation",
    "url": "https://docs.python.org/3/tutorial/", "excerpt": "The keyword def defines a function.",
    "location": "Article, character 1", "kind": "web",
}
CONTEXT = {"path_id": "path-one", "path_title": "Python", "node_title": "Functions"}


@pytest.fixture(autouse=True)
def resolved_question(monkeypatch):
    # Context resolution has its own tests; these exercise evidence and answer checks.
    monkeypatch.setattr(ai, "resolve_question", lambda provider, model, context, prompt: ai.ResolvedQuestion(
        question=prompt, search_query=prompt, sources_only=bool(context.get("sources_only")),
    ))


@pytest.fixture
def supported_answer(monkeypatch):
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [dict(EVIDENCE)], "warnings": [],
        "web_search_performed": bool(kwargs.get("supplement_web")),
    })
    return ai.DraftAnswer(
        status="answered", blocks=[ai.AnswerBlock(text="Use `def` to define a function.", evidence_ids=["chunk-one"])],
        reason="",
    )


def test_sources_only_without_evidence_does_not_generate_an_answer(monkeypatch):
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": ["Web search unavailable."],
    })
    monkeypatch.setattr(ai, "structured_completion", lambda *args: pytest.fail("Must not generate without evidence"))
    result = ai.answer(None, {**CONTEXT, "sources_only": True}, "Explain functions")
    assert result["status"] == "abstained"
    assert result["evaluation"]["status"] == "evidence_unavailable"
    assert "Add a relevant document or URL" in result["content"]
    assert result["evaluation"]["retrieval_warnings"] == ["Web search unavailable."]


@pytest.mark.parametrize("citations", [[], ["invented-source"]])
def test_missing_or_invented_citations_are_withheld(monkeypatch, supported_answer, citations):
    supported_answer.blocks[0].evidence_ids = citations
    calls = []

    def complete(*args):
        calls.append(args)
        return supported_answer

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain functions")
    assert result["evaluation"]["status"] == "invalid_citations"
    assert "Use `def`" not in result["content"]
    assert len(calls) == 1


def test_supported_answer_records_exact_citations_and_evaluation(monkeypatch, supported_answer):
    results = iter([
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=0.8, consistency=1, grounding=1,
                      supported=True, explanation="The cited excerpt supports the claim."),
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(results))
    answer = ai.answer(None, CONTEXT, "How are functions defined?")
    assert answer["content"] == "Use `def` to define a function.\n\n[1]"
    assert answer["evidence"] == [EVIDENCE]
    assert answer["evaluation"]["completeness"] == 0.8
    assert answer["evaluation"]["citations_valid"] is True
    assert answer["evaluation"]["evaluated_at"]


def test_model_written_source_id_is_replaced_by_numbered_citation(monkeypatch, supported_answer):
    source_id = "09292f47-71fd-4767-8aeb-f4ddd459e5c6"
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [{**EVIDENCE, "id": source_id}], "warnings": [], "web_search_performed": False,
    })
    supported_answer.blocks[0].text = f"Use `def` to define a function. [{source_id}]"
    supported_answer.blocks[0].evidence_ids = [source_id]
    results = iter([
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                            supported=True, explanation="The cited excerpt supports the claim."),
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(results))

    result = ai.answer(None, CONTEXT, "How are functions defined?")

    assert result["status"] == "answered"
    assert result["content"] == "Use `def` to define a function.\n\n[1]"


def test_unknown_model_written_source_id_is_withheld(monkeypatch, supported_answer):
    supported_answer.blocks[0].text = (
        "Use `def` to define a function. [09292f47-71fd-4767-8aeb-f4ddd459e5c6]"
    )
    monkeypatch.setattr(ai, "structured_completion", lambda *args: supported_answer)

    result = ai.answer(None, CONTEXT, "How are functions defined?")

    assert result["evaluation"]["status"] == "invalid_citations"
    assert "Use `def`" not in result["content"]


@pytest.mark.parametrize("action, expected", [
    ("foundation", "220-350 words"),
    ("deeper", "220-350 words"),
    ("question", "Answer every part"),
])
def test_answer_depth_guidance_reaches_writer_and_reviewer(
    monkeypatch, supported_answer, action, expected,
):
    calls = []

    def complete(provider, model, schema, messages):
        calls.append((schema, messages))
        if schema == ai.DraftAnswer:
            return supported_answer
        return ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                                   supported=True, explanation="Supported answer.")

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, {**CONTEXT, "answer_action": action}, "Explain functions")
    assert result["status"] == "answered"
    assert len(calls) == (4 if action in {"foundation", "deeper"} else 2)
    for _, messages in calls:
        assert expected in json.loads(messages[1]["content"])["context"]["response_guidance"]
    assert "focused teaching explanation" in calls[0][1][0]["content"]
    assert "context.response_guidance" in calls[1][1][0]["content"]


def test_detailed_question_expands_a_supported_but_brief_answer(monkeypatch, supported_answer):
    rich_source = {**EVIDENCE, "kind": "text", "excerpt": (
        "A function is defined with def and can accept parameters. Its body runs when called. "
        "A return statement sends a result to the caller. "
    ) * 36}
    searches = []

    def retrieve(*args, **kwargs):
        searches.append(kwargs)
        return {"evidence": [rich_source], "warnings": [], "web_search_performed": False}

    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    expanded = ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
        text="The def keyword names a function and its parameters. Calling it runs the body, "
             "and a return statement sends a result to the caller.",
        evidence_ids=["chunk-one"],
    )])
    review = ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                                 supported=True, explanation="All claims are supported.")
    outputs = iter([supported_answer, review, expanded, review])
    calls = []

    def complete(provider, model, schema, messages):
        calls.append((schema, messages))
        return next(outputs)

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain functions in detail")
    assert result["status"] == "answered"
    assert result["content"].startswith("The def keyword names a function")
    assert result["evaluation"]["expansion_attempted"] is True
    assert len(result["evaluation"]["checks"]) == 2
    assert [schema for schema, _ in calls] == [
        ai.DraftAnswer, ai.AnswerEvaluation, ai.DraftAnswer, ai.AnswerEvaluation,
    ]
    assert "too brief" in json.loads(calls[2][1][1]["content"])["evaluation_feedback"]
    assert len(searches) == 1


def test_failed_detailed_expansion_keeps_the_verified_answer(monkeypatch, supported_answer):
    rich_source = {**EVIDENCE, "excerpt": "The keyword def defines a function. " * 100}
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [rich_source], "warnings": [], "web_search_performed": False,
    })
    unsupported = ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
        text="Functions cannot accept parameters.", evidence_ids=["chunk-one"],
    )])
    outputs = iter([
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                            supported=True, explanation="Supported."),
        unsupported,
        ai.AnswerEvaluation(relevance=1, completeness=0.2, consistency=0.2, grounding=0.2,
                            supported=False, explanation="The expansion is unsupported."),
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(outputs))
    result = ai.answer(None, CONTEXT, "Explain functions in detail")
    assert result["status"] == "answered"
    assert result["content"] == "Use `def` to define a function.\n\n[1]"
    assert result["evaluation"]["partial_answer_preserved"] is True
    assert result["evaluation"]["expansion_attempted"] is True


@pytest.mark.parametrize("sources_only, expected_status", [
    (False, "unverified"), (True, "abstained"),
])
def test_deeper_followup_does_not_present_a_shallow_partial_as_complete(
    monkeypatch, supported_answer, sources_only, expected_status,
):
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [dict(EVIDENCE)], "warnings": [], "web_search_performed": True,
    })
    review = ai.AnswerEvaluation(
        relevance=1, completeness=0.8, consistency=1, grounding=1,
        supported=True, explanation="The sources support only a brief answer.",
    )
    responses = [supported_answer, review, supported_answer.model_copy(deep=True), review]
    if not sources_only:
        responses.append(ai.GeneralAnswer(
            can_answer=True, content="A fuller general explanation of how functions work.", reason="",
        ))
    calls = []

    def complete(provider, model, schema, messages):
        calls.append(schema)
        return responses.pop(0)

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, {
        **CONTEXT, "answer_action": "deeper", "sources_only": sources_only,
        "focus_interaction": {
            "prompt": "How do functions work?", "content": "A function can have parameters.",
            "status": "answered",
        },
    }, "Go deeper into the selected answer")

    assert result["status"] == expected_status
    assert result["evaluation"]["status"] == (
        "unverified" if not sources_only else "insufficient_depth"
    )
    assert result["content"] != "Use `def` to define a function.\n\n[1]"
    assert calls == ([ai.DraftAnswer, ai.AnswerEvaluation] * 2
                     + ([] if sources_only else [ai.GeneralAnswer]))


def test_deeper_followup_withholds_shallow_partial_after_failed_revision(
    monkeypatch, supported_answer,
):
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [dict(EVIDENCE)], "warnings": [], "web_search_performed": True,
    })
    unsupported = ai.DraftAnswer(status="answered", reason="", blocks=[
        ai.AnswerBlock(text="Functions never return values.", evidence_ids=["chunk-one"]),
    ])
    responses = iter([
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=0.7, consistency=1, grounding=1,
                            supported=True, explanation="Only a brief description is supported."),
        unsupported,
        ai.AnswerEvaluation(relevance=1, completeness=0.3, consistency=0.2, grounding=0.2,
                            supported=False, explanation="The revision contradicts the source."),
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(responses))

    result = ai.answer(None, {
        **CONTEXT, "answer_action": "deeper",
        "focus_interaction": {
            "prompt": "How do functions work?", "content": "A function can have parameters.",
            "status": "answered",
        },
    }, "Go deeper into the selected answer")

    assert result["status"] == "abstained"
    assert result["evaluation"]["status"] == "low_grounding"


def test_detailed_question_researches_shallow_sources_before_expanding(monkeypatch):
    supplied = {**EVIDENCE, "excerpt": "Functions can have names and parameters. " * 80}
    discovered = {**EVIDENCE, "id": "web-detail", "source_id": "web-source",
                  "excerpt": "Calling a function binds arguments, runs its body, and returns a result."}
    searches = []

    def retrieve(session, query, **kwargs):
        searches.append((query, kwargs))
        return {
            "evidence": [supplied, discovered] if kwargs.get("supplement_web") else [supplied],
            "warnings": [], "web_search_performed": bool(kwargs.get("supplement_web")),
        }

    first = ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
        text="Functions have names and parameters.", evidence_ids=["chunk-one"],
    )])
    expanded = ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
        text="Calling a function binds arguments, runs its body, and returns a result.",
        evidence_ids=["web-detail"],
    )])
    outputs = iter([
        first,
        ai.AnswerEvaluation(relevance=1, completeness=0.8, consistency=1, grounding=1,
                            supported=True, explanation="Only the parts are named."),
        expanded,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                            supported=True, explanation="The mechanism is supported."),
    ])
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(outputs))
    result = ai.answer(None, CONTEXT, "Explain functions in detail")
    assert result["status"] == "answered"
    assert result["evidence"] == [discovered]
    assert result["evaluation"]["web_search_performed"] is True
    assert result["evaluation"]["expansion_attempted"] is True
    assert searches[1][0].endswith("detailed explanation mechanisms examples")
    assert searches[1][1]["supplement_web"] is True


def test_foundation_researches_when_a_brief_answer_has_sparse_evidence(monkeypatch):
    supplied = {**EVIDENCE, "title": "General Python overview",
                "excerpt": "Functions can have names and parameters. " * 40}
    discovered = {**EVIDENCE, "id": "web-detail", "source_id": "web-source",
                  "title": "Python function tutorial",
                  "excerpt": "A function runs its body when called and returns a result to the caller."}
    searches = []

    def retrieve(session, query, **kwargs):
        searches.append((query, kwargs))
        return {
            "evidence": [supplied, discovered] if kwargs.get("supplement_web") else [supplied],
            "warnings": [], "web_search_performed": bool(kwargs.get("supplement_web")),
        }

    brief = ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
        text="Functions can have names and parameters.", evidence_ids=["chunk-one"],
    )])
    expanded = ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
        text="A function has a name and parameters. When called, it runs its body and returns a "
             "result to the caller.", evidence_ids=["chunk-one", "web-detail"],
    )])
    review = ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                                 supported=True, explanation="The cited claims are supported.")
    outputs = iter([brief, review, expanded, review])
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(outputs))

    result = ai.answer(None, {**CONTEXT, "answer_action": "foundation"}, "Introduce functions")

    assert result["status"] == "answered"
    assert result["evidence"] == [supplied, discovered]
    assert result["evaluation"]["web_search_performed"] is True
    assert result["evaluation"]["expansion_attempted"] is True
    assert len(result["evaluation"]["checks"]) == 2
    assert len(searches) == 2
    assert searches[1][1]["supplement_web"] is True


def test_generated_citations_stay_outside_fenced_code(monkeypatch, supported_answer):
    supported_answer.blocks[0].text = "Example:\n\n```python\nitems.append(4)\n```"
    supported_answer.blocks.append(ai.AnswerBlock(
        text="The item is added to the end.", evidence_ids=["chunk-one"],
    ))
    results = iter([
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                      supported=True, explanation="The example is supported."),
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(results))
    answer = ai.answer(None, CONTEXT, "Show append")
    tokens = MarkdownIt().parse(answer["content"])
    code = [token.content for token in tokens if token.type == "fence"]
    assert code == ["items.append(4)\n"]
    assert sum(token.content == "[1]" for token in tokens if token.type == "inline") == 2
    assert any(token.content == "The item is added to the end." for token in tokens)


def test_failed_correction_is_withheld_concisely(monkeypatch, supported_answer):
    internal_feedback = "Unsupported comparison in 851a8f96-7831-4ce2-aa5c-dad182fc51c5. " * 20
    results = iter([
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=0.1, grounding=0.1,
                      supported=False, explanation=internal_feedback),
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=0.89,
                      supported=True, explanation=internal_feedback),
    ])
    calls = []

    def complete(*args):
        calls.append(args)
        return next(results)

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain functions")
    assert result["evaluation"]["status"] == "low_grounding"
    assert "Use `def`" not in result["content"]
    assert "851a8f96" not in result["content"]
    assert len(result["content"]) < 180
    assert result["evaluation"]["explanation"] == internal_feedback
    assert result["evaluation"]["correction_attempted"] is True
    assert len(result["evaluation"]["checks"]) == 2
    assert len(calls) == 4


def test_one_correction_uses_same_evidence_and_passes_fresh_evaluation(monkeypatch, supported_answer):
    unsupported = supported_answer.model_copy(deep=True)
    unsupported.blocks[0].text += " Unlike classes, functions can only take one argument."
    feedback = "Remove the comparison with classes; the cited excerpt does not support it."
    results = iter([
        unsupported,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=0.2, grounding=0.5,
                      supported=False, explanation=feedback),
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                      supported=True, explanation="Every remaining claim is supported."),
    ])
    calls = []

    def complete(provider, model, schema, messages):
        calls.append((schema, json.loads(messages[1]["content"])))
        return next(results)

    monkeypatch.setattr(ai, "structured_completion", complete)
    answer = ai.answer(None, CONTEXT, "How are functions defined?")
    assert answer["content"] == "Use `def` to define a function.\n\n[1]"
    assert answer["status"] == "answered"
    assert [schema for schema, _ in calls] == [ai.DraftAnswer, ai.AnswerEvaluation, ai.DraftAnswer, ai.AnswerEvaluation]
    assert calls[2][1]["previous_answer"] == unsupported.model_dump()
    assert calls[2][1]["evaluation_feedback"] == feedback
    assert calls[2][1]["evidence"] == calls[0][1]["evidence"] == [EVIDENCE]
    assert calls[3][1]["answer"] == supported_answer.model_dump()
    assert "evaluation_feedback" not in calls[3][1]
    assert answer["evaluation"]["correction_attempted"] is True
    assert [check["supported"] for check in answer["evaluation"]["checks"]] == [False, True]


def test_correction_provider_failure_still_withholds(monkeypatch, supported_answer):
    calls = []

    def complete(provider, model, schema, messages):
        calls.append(schema)
        if len(calls) == 1:
            return supported_answer
        if schema == ai.AnswerEvaluation:
            return ai.AnswerEvaluation(relevance=1, completeness=1, consistency=0.2, grounding=0.2,
                                 supported=False, explanation="Unsupported comparison.")
        raise HTTPException(503, "Correction provider unavailable.")

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain functions")
    assert result["status"] == "abstained"
    assert result["evaluation"]["status"] == "correction_failed"
    assert result["evaluation"]["correction_attempted"] is True
    assert "Use `def`" not in result["content"]
    assert calls == [ai.DraftAnswer, ai.AnswerEvaluation, ai.DraftAnswer]


def test_corrected_draft_must_still_pass_citation_membership(monkeypatch, supported_answer):
    invalid = supported_answer.model_copy(deep=True)
    invalid.blocks[0].evidence_ids = ["invented-after-correction"]
    results = iter([
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=0.2, grounding=0.2,
                      supported=False, explanation="Unsupported comparison."),
        invalid,
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(results))
    result = ai.answer(None, CONTEXT, "Explain functions")
    assert result["evaluation"]["status"] == "invalid_citations"
    assert result["evaluation"]["correction_attempted"] is True
    assert len(result["evaluation"]["checks"]) == 1
    assert "invented-after-correction" not in result["content"]


def test_evaluation_outage_withholds_candidate(monkeypatch, supported_answer):
    def complete(provider, model, schema, messages):
        if schema == ai.DraftAnswer:
            return supported_answer
        raise HTTPException(503, "Evaluation provider unavailable.")

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain functions")
    assert result["evaluation"]["status"] == "evaluation_failed"
    assert "Use `def`" not in result["content"]
    assert result["evaluation"]["correction_attempted"] is False
    assert result["content"] == "I couldn't complete the evidence check. Please try again."


def test_nested_curriculum_derives_valid_parent_references(monkeypatch):
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    curriculum = ai.Curriculum(
        title="Python", description="A course", nodes=[ai.CurriculumNode(
            title="Functions", description="Functions", evidence_ids=[], children=[ai.CurriculumNode(
                title="Parameters", description="Parameters", evidence_ids=[], children=[ai.CurriculumNode(
                    title="Defaults", description="Defaults", evidence_ids=[], children=[],
                )],
            )],
        )],
    )
    results = iter([
        curriculum,
        ai.CurriculumEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                      supported=True, explanation="The outline is faithfully represented.",
                      missing_topics=[], hierarchy_preserved=True),
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(results))
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: pytest.fail("Outline imports use the supplied outline"))
    result = ai.generate_curriculum(None, "Functions\n  Parameters\n    Defaults", "outline", [])
    assert [node["parent_index"] for node in result["nodes"]] == [None, 0, 1]
    assert [node["title"] for node in result["nodes"]] == ["Functions", "Parameters", "Defaults"]
    assert all(node["evidence_ids"] == [] for node in result["nodes"])
    assert result["generation"]["mode"] == "outline"
    assert result["generation"]["evidence"] == []
    assert result["generation"]["evaluation"]["method"] == "model_outline_fidelity"


def test_step_and_arrow_outline_reaches_model_as_required_hierarchy(monkeypatch):
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    text = """Step 1: Master the Fundamentals
→ LLMs
→ Embeddings
Why they work and where they fail.

Step 2: Learn System Design
→ RAG Architectures
"""
    curriculum = ai.Curriculum(
        title="AI interview preparation", description="Study the supplied outline", nodes=[
            ai.CurriculumNode(
                title="Step 1: Master the Fundamentals", description="Learn fundamentals",
                evidence_ids=[], children=[
                    ai.CurriculumNode(title=title, description=f"Study {title}",
                                      evidence_ids=[], children=[])
                    for title in ("LLMs", "Embeddings")
                ],
            ),
            ai.CurriculumNode(
                title="Step 2: Learn System Design", description="Learn system design",
                evidence_ids=[], children=[ai.CurriculumNode(
                    title="RAG Architectures", description="Study RAG architectures",
                    evidence_ids=[], children=[],
                )],
            ),
        ],
    )
    review = ai.CurriculumEvaluation(
        relevance=1, completeness=1, consistency=1, grounding=1, supported=True,
        explanation="The outline is preserved.", missing_topics=[], hierarchy_preserved=True,
    )
    calls = []

    def complete(provider, model, schema, messages):
        calls.append((schema, json.loads(messages[1]["content"])))
        return curriculum if schema == ai.Curriculum else review

    monkeypatch.setattr(ai, "structured_completion", complete)
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: pytest.fail("No web for outline imports"))
    result = ai.generate_curriculum(None, text, "outline", [])

    assert calls[0][1]["required_outline_paths"] == [
        ["Step 1: Master the Fundamentals"],
        ["Step 1: Master the Fundamentals", "LLMs"],
        ["Step 1: Master the Fundamentals", "Embeddings"],
        ["Step 2: Learn System Design"],
        ["Step 2: Learn System Design", "RAG Architectures"],
    ]
    assert [node["parent_index"] for node in result["nodes"]] == [None, 0, 0, None, 3]
    assert [schema for schema, _ in calls] == [ai.Curriculum, ai.CurriculumEvaluation]


@pytest.mark.parametrize("evidence_ids", [[], ["invented-curriculum-reference"]])
def test_goal_curriculum_requires_valid_citations_for_every_node(monkeypatch, supported_answer, evidence_ids):
    calls = []

    def complete(provider, model, schema, messages):
        calls.append(schema)
        if schema == ai.GoalPlan:
            return ai.GoalPlan(title="Functions", description="A course", nodes=[ai.GoalBranch(
                title="Definitions", description="Define functions", children=[],
                search_query="Python function definitions",
            )])
        return ai.Curriculum(title="Functions", description="A course", nodes=[ai.CurriculumNode(
            title="Definitions", description="Define functions", evidence_ids=evidence_ids, children=[],
        )])

    monkeypatch.setattr(ai, "structured_completion", complete)
    with pytest.raises(HTTPException) as error:
        ai.generate_curriculum(None, "Learn function definitions", "goal", [])
    assert error.value.status_code == 502
    assert "verifiable sources" in error.value.detail
    assert calls == [ai.GoalPlan, ai.Curriculum, ai.Curriculum]


def test_goal_curriculum_returns_exact_provenance_after_support_check(monkeypatch, supported_answer):
    results = iter([
        ai.GoalPlan(title="Functions", description="Learn definitions", nodes=[ai.GoalBranch(
            title="Definitions", description="Define functions", children=[],
            search_query="Python function definitions",
        )]),
        ai.Curriculum(title="Functions", description="Learn definitions", nodes=[ai.CurriculumNode(
            title="Definitions", description="Define functions", evidence_ids=["chunk-one"], children=[],
        )]),
        ai.CurriculumEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                      supported=True, explanation="The cited excerpt supports each topic.",
                      missing_topics=[], hierarchy_preserved=True),
    ])
    calls = []

    def complete(provider, model, schema, messages):
        calls.append((schema, json.loads(messages[1]["content"])))
        return next(results)

    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.generate_curriculum(None, "Learn function definitions", "goal", [])
    assert result["nodes"][0]["evidence_ids"] == ["chunk-one"]
    assert result["generation"]["provider"] == "azure"
    assert result["generation"]["model"] == "test-model"
    assert result["generation"]["evidence"] == [EVIDENCE]
    assert result["generation"]["title"] == result["title"]
    assert result["generation"]["description"] == result["description"]
    assert result["generation"]["nodes"] == result["nodes"]
    assert result["generation"]["evaluation"]["status"] == "passed"
    assert result["generation"]["created_at"]
    assert [schema for schema, _ in calls] == [ai.GoalPlan, ai.Curriculum, ai.CurriculumEvaluation]
    assert calls[2][1]["curriculum"]["nodes"][0]["evidence_ids"] == ["chunk-one"]


def test_goal_curriculum_rejects_unsupported_topics_despite_valid_ids(monkeypatch, supported_answer):
    curriculum = ai.Curriculum(title="Functions", description="A course", nodes=[ai.CurriculumNode(
        title="Quantum functions", description="Invented topic", evidence_ids=["chunk-one"], children=[],
    )])
    rejected = ai.CurriculumEvaluation(
        relevance=1, completeness=1, consistency=0.1, grounding=0.1, supported=False,
        explanation="The cited excerpt does not support this topic.",
        missing_topics=[], hierarchy_preserved=True,
    )
    results = iter([
        ai.GoalPlan(title="Functions", description="A course", nodes=[ai.GoalBranch(
            title="Quantum functions", description="Invented topic", children=[],
            search_query="Python function definitions",
        )]),
        curriculum, rejected, curriculum, rejected, rejected,
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(results))
    with pytest.raises(HTTPException) as error:
        ai.generate_curriculum(None, "Learn function definitions", "goal", [])
    assert "outline did not cover your goal reliably" in error.value.detail


@pytest.mark.parametrize("supported,completeness", [(False, 1), (True, 0.8)])
def test_outline_import_rejects_invented_or_omitted_topics(monkeypatch, supported_answer, supported, completeness):
    results = iter([
        ai.Curriculum(title="Functions", description="A course", nodes=[ai.CurriculumNode(
            title="Definitions", description="Define functions", evidence_ids=[], children=[],
        )]),
        ai.CurriculumEvaluation(relevance=1, completeness=completeness, consistency=1, grounding=1,
                      supported=supported, explanation="The original outline was not preserved.",
                      missing_topics=[], hierarchy_preserved=True),
    ])
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(results))
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: pytest.fail("No web for outline imports"))
    with pytest.raises(HTTPException) as error:
        ai.generate_curriculum(None, "Functions\nParameters\nReturn values", "outline", [])
    assert "faithfully preserve" in error.value.detail


def test_insufficient_cached_web_triggers_fresh_research(monkeypatch, supported_answer):
    calls = []
    new_evidence = {**EVIDENCE, "id": "new-chunk", "title": "Freshly fetched documentation"}

    def retrieve(*args, **kwargs):
        calls.append(kwargs)
        if kwargs.get("supplement_web"):
            return {"evidence": [new_evidence], "warnings": ["One web page was unavailable."], "web_search_performed": True}
        return {"evidence": [dict(EVIDENCE)], "warnings": []}

    supported_answer.blocks[0].evidence_ids = ["new-chunk"]
    completions = iter([
        ai.DraftAnswer(status="insufficient", blocks=[], reason="The cached source is incomplete."),
        supported_answer,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                            supported=True, explanation="The new excerpt supports the answer."),
    ])
    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(completions))
    result = ai.answer(None, CONTEXT, "Explain functions")
    assert result["status"] == "answered"
    assert calls[1]["supplement_web"] is True
    assert result["evidence"] == [new_evidence]
    assert result["evaluation"]["retrieval_warnings"] == ["One web page was unavailable."]


@pytest.mark.parametrize("gap_detected_by", ["draft", "review", "partial_review"])
def test_missing_question_coverage_gets_targeted_web_evidence(monkeypatch, gap_detected_by):
    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    supplied = {**EVIDENCE, "kind": "text"}
    discovered = {
        **EVIDENCE, "id": "web-chunk", "source_id": "web-source",
        "excerpt": "A function may define default values for its parameters.",
    }
    search_query = "Python function default parameter values official documentation"
    calls = []

    def retrieve(session, query, **kwargs):
        calls.append((query, kwargs))
        return {
            "evidence": [supplied, discovered] if kwargs.get("supplement_web") else [supplied],
            "warnings": [], "web_search_performed": bool(kwargs.get("supplement_web")),
        }

    partial = ai.DraftAnswer(
        status="answered", reason="", blocks=[ai.AnswerBlock(
            text="Use def to define a function. The source does not cover parameter defaults.",
            evidence_ids=[supplied["id"]],
        )], missing_evidence=search_query if gap_detected_by == "draft" else "",
    )
    complete = ai.DraftAnswer(status="answered", reason="", blocks=[
        ai.AnswerBlock(text="Use def to define a function.", evidence_ids=[supplied["id"]]),
        ai.AnswerBlock(text="Parameters can have default values.", evidence_ids=[discovered["id"]]),
    ])
    outputs = [partial]
    if gap_detected_by != "draft":
        supported = gap_detected_by == "partial_review"
        outputs.append(ai.AnswerEvaluation(
            relevance=1, completeness=0.5, consistency=1, grounding=1 if supported else 0.5,
            supported=supported, explanation="Need evidence for default parameter values.",
            missing_evidence=search_query,
        ))
    outputs += [complete, ai.AnswerEvaluation(
        relevance=1, completeness=1, consistency=1, grounding=1,
        supported=True, explanation="Both parts are supported.",
    )]
    outputs = iter(outputs)
    payloads = []

    def completion(provider, model, schema, messages):
        payloads.append(json.loads(messages[1]["content"]))
        return next(outputs)

    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", completion)
    result = ai.answer(None, CONTEXT, "Explain function definitions and parameter defaults")
    assert result["status"] == "answered"
    assert result["evidence"] == [supplied, discovered]
    assert calls[1] == (search_query, {"path_id": "path-one", "supplement_web": True})
    assert len(calls) == 2
    assert payloads[-1]["evidence"] == [supplied, discovered]
    assert payloads[-1]["answer"] == complete.model_dump()
    assert result["evaluation"]["web_search_performed"] is True
    assert result["evaluation"]["web_search_query"] == search_query


def test_failed_web_search_can_keep_a_checked_partial_answer(monkeypatch, supported_answer):
    supported_answer.blocks[0].text += " The available evidence does not cover parameter defaults."
    supported_answer.missing_evidence = "Python default parameters documentation"
    calls = []

    def retrieve(*args, **kwargs):
        calls.append(kwargs)
        return {
            "evidence": [EVIDENCE],
            "warnings": ["Web search is unavailable."] if kwargs.get("supplement_web") else [],
            "web_search_performed": bool(kwargs.get("supplement_web")),
        }

    outputs = iter([supported_answer, ai.AnswerEvaluation(
        relevance=1, completeness=0.5, consistency=1, grounding=1,
        supported=True, explanation="Supported partial answer with a clear limitation.",
        missing_evidence="Python default parameters documentation",
    )])
    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(outputs))
    result = ai.answer(None, CONTEXT, "Explain functions and default parameters")
    assert result["status"] == "answered"
    assert "does not cover parameter defaults" in result["content"]
    assert len(calls) == 2
    assert result["evaluation"]["web_search_performed"] is True
    assert result["evaluation"]["retrieval_warnings"] == ["Web search is unavailable."]


def test_initial_web_search_counts_towards_the_question_budget(monkeypatch, supported_answer):
    calls = []

    def retrieve(*args, **kwargs):
        calls.append(kwargs)
        return {"evidence": [EVIDENCE], "warnings": [], "web_search_performed": True}

    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", lambda *args: ai.DraftAnswer(
        status="insufficient", blocks=[], reason="Missing parameter default documentation.",
        missing_evidence="Python default parameters documentation",
    ))
    result = ai.answer(None, {**CONTEXT, "sources_only": True}, "Explain default parameters")
    assert result["status"] == "abstained"
    assert result["evaluation"]["status"] == "insufficient_evidence"
    assert result["evaluation"]["web_search_performed"] is True
    assert len(calls) == 1


def test_embedding_failure_does_not_report_a_web_search(monkeypatch, supported_answer):
    calls = []
    supported_answer.missing_evidence = "Python parameter defaults"

    def retrieve(*args, **kwargs):
        calls.append(kwargs)
        if kwargs.get("supplement_web"):
            return {"evidence": [], "warnings": ["Embedding provider unavailable."],
                    "web_search_performed": False}
        return {"evidence": [EVIDENCE], "warnings": [], "web_search_performed": False}

    outputs = iter([supported_answer, ai.AnswerEvaluation(
        relevance=1, completeness=0.5, consistency=1, grounding=1, supported=True,
        explanation="The supported portion is correct.", missing_evidence="Python parameter defaults",
    )])
    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    monkeypatch.setattr(ai, "structured_completion", lambda *args: next(outputs))
    result = ai.answer(None, CONTEXT, "Explain functions and parameter defaults")
    assert result["status"] == "answered"
    assert result["evaluation"]["web_search_performed"] is False
    assert result["evaluation"]["web_search_query"] is None
    assert result["evaluation"]["retrieval_warnings"] == ["Embedding provider unavailable."]
    assert len(calls) == 2


@pytest.mark.parametrize("failure", ["unsupported", "provider", "citations"])
def test_verified_partial_survives_unsuccessful_expansion(monkeypatch, supported_answer, failure):
    supplied = {**EVIDENCE, "kind": "text"}
    discovered = {**EVIDENCE, "id": "new-chunk", "source_id": "new-source"}
    supported_answer.blocks[0].text += " The available evidence does not cover parameter defaults."
    partial_check = ai.AnswerEvaluation(
        relevance=1, completeness=0.5, consistency=1, grounding=1, supported=True,
        explanation="The partial answer is supported and acknowledges the missing information.",
        missing_evidence="Python parameter defaults documentation",
    )
    expanded = ai.DraftAnswer(status="answered", reason="", blocks=[ai.AnswerBlock(
        text="An unsupported claim about defaults.",
        evidence_ids=["invented"] if failure == "citations" else [discovered["id"]],
    )])
    outputs = iter([
        supported_answer, partial_check,
        HTTPException(503, "Provider unavailable.") if failure == "provider" else expanded,
        ai.AnswerEvaluation(relevance=1, completeness=1, consistency=0.5, grounding=0.5,
                            supported=False, explanation="The fuller draft is unsupported."),
    ])

    def complete(*args):
        output = next(outputs)
        if isinstance(output, Exception):
            raise output
        return output

    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [supplied, discovered] if kwargs.get("supplement_web") else [supplied],
        "warnings": [], "web_search_performed": bool(kwargs.get("supplement_web")),
    })
    monkeypatch.setattr(ai, "structured_completion", complete)
    result = ai.answer(None, CONTEXT, "Explain functions and parameter defaults")
    assert result["status"] == "answered"
    assert "does not cover parameter defaults" in result["content"]
    assert "unsupported claim" not in result["content"]
    assert result["evidence"] == [supplied]
    assert result["evaluation"]["status"] == "passed"
    assert result["evaluation"]["explanation"] == partial_check.explanation
    assert result["evaluation"]["partial_answer_preserved"] is True


@pytest.mark.parametrize("provider", ["azure", "openai", "openrouter", "ollama"])
def test_all_provider_requests_use_selected_model_and_expected_endpoint(monkeypatch, provider):
    from trellis.config import settings
    from trellis.provider_routes import ConnectionCheck

    monkeypatch.setattr(settings, "azure_openai_endpoint", "https://azure.example")
    monkeypatch.setattr(settings, "azure_openai_api_key", "azure-secret")
    monkeypatch.setattr(settings, "openai_api_key", "openai-secret")
    monkeypatch.setattr(settings, "openrouter_api_key", "router-secret")
    monkeypatch.setattr(settings, "openai_base_url", "https://openai.example/v1")
    monkeypatch.setattr(settings, "openrouter_base_url", "https://router.example/api/v1")
    monkeypatch.setattr(settings, "ollama_base_url", "http://localhost:11434/v1")
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={
            "id": "test", "object": "chat.completion", "created": 1, "model": "chosen-model",
            "choices": [{"index": 0, "finish_reason": "stop", "message": {
                "role": "assistant", "content": '{"status":"ready"}',
            }}],
        })

    real_openai, real_azure = ai.OpenAI, ai.AzureOpenAI
    monkeypatch.setattr(ai, "OpenAI", lambda **kwargs: real_openai(
        **kwargs, http_client=httpx.Client(transport=httpx.MockTransport(respond)),
    ))
    monkeypatch.setattr(ai, "AzureOpenAI", lambda **kwargs: real_azure(
        **kwargs, http_client=httpx.Client(transport=httpx.MockTransport(respond)),
    ))
    result = ai.structured_completion(provider, "chosen-model", ConnectionCheck, [
        {"role": "user", "content": "Return ready."},
    ])
    assert result.status == "ready"
    payload = json.loads(requests[0].content)
    assert payload["model"] == "chosen-model"
    assert payload["response_format"]["json_schema"]["strict"] is True
    assert requests[0].url.host == {
        "azure": "azure.example", "openai": "openai.example",
        "openrouter": "router.example", "ollama": "localhost",
    }[provider]
    if provider == "azure":
        assert "/deployments/chosen-model/" in requests[0].url.path
        assert requests[0].headers["api-key"] == "azure-secret"


def test_settings_persist_model_without_revealing_credentials(client, monkeypatch):
    from trellis.config import settings

    monkeypatch.setattr(settings, "azure_openai_api_key", "do-not-return-this-secret")
    response = client.put("/api/settings", json={"provider": "azure", "model": "chosen-deployment"})
    assert response.status_code == 200
    current = client.get("/api/settings")
    assert current.json()["model"] == "chosen-deployment"
    assert "do-not-return-this-secret" not in current.text
    ollama = next(item for item in current.json()["providers"] if item["id"] == "ollama")
    assert ":11434/" in ollama["base_url"]


def test_provider_error_never_exposes_remote_body():
    error = openai.BadRequestError(
        "SECRET_API_KEY and private prompt", response=httpx.Response(
            400, request=httpx.Request("POST", "https://example.com"),
        ), body={"secret": "SECRET_API_KEY"},
    )
    mapped = ai.provider_error(error)
    assert "SECRET_API_KEY" not in mapped.detail
    assert "structured JSON" in mapped.detail


def test_private_urls_are_rejected(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
    ])
    for url in ("http://localhost", "http://127.0.0.1", "http://private.example"):
        with pytest.raises(HTTPException) as error:
            evidence.public_url(url)
        assert error.value.status_code == 422


def test_fetch_pins_dns_and_blocks_private_redirect(monkeypatch):
    def resolve(host, *args, **kwargs):
        address = "127.0.0.1" if host == "127.0.0.1" else "93.184.215.14"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]

    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(302, headers={"Location": "http://127.0.0.1/secrets"})

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    client = httpx.Client(transport=httpx.MockTransport(respond))
    monkeypatch.setattr(evidence.httpx, "Client", lambda **kwargs: client)
    with pytest.raises(HTTPException):
        evidence.fetch_document("https://example.com/article")
    assert len(seen) == 1
    assert seen[0].url.host == "93.184.215.14"
    assert seen[0].headers["Host"] == "example.com"
    assert seen[0].extensions["sni_hostname"] == "example.com"


def test_github_repository_indexes_full_readme(monkeypatch):
    repository_url = "https://github.com/ashishps1/awesome-system-design-resources"
    readme = """# Awesome System Design Resources

## Networking Fundamentals
- DNS resolves domain names to addresses.
- TCP establishes connections between hosts.

## API Fundamentals
- APIs define how clients and services communicate.

## Asynchronous Communication
- Message queues decouple producers and consumers.
"""
    fetched = []

    def fetch(url, *, accept=None):
        fetched.append((url, accept))
        return readme.encode(), "application/vnd.github.raw+json", url

    monkeypatch.setattr(evidence, "fetch_document", fetch)
    monkeypatch.setattr(evidence, "embed_texts", lambda texts: (
        [[1, 0, 0] for _ in texts], "test:3",
    ))
    source = Source(title="System design", kind="url", url=repository_url)

    chunks = evidence.prepare_source_chunks(source)

    assert fetched == [(
        "https://api.github.com/repos/ashishps1/awesome-system-design-resources/readme",
        "application/vnd.github.raw+json",
    )]
    assert source.url == repository_url
    assert source.status == "ready"
    assert "## Networking Fundamentals" in source.content
    assert "## Asynchronous Communication" in source.content
    assert chunks[0].location.startswith("GitHub README")


def test_pdf_parser_preserves_page_locations(tmp_path, monkeypatch):
    from trellis.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    pdf.drawString(72, 720, "Functions use the def keyword.")
    pdf.showPage()
    pdf.drawString(72, 720, "Return statements provide a result.")
    pdf.save()
    (tmp_path / "sources").mkdir()
    path = tmp_path / "sources" / "course.pdf"
    path.write_bytes(buffer.getvalue())
    sections = evidence.document_sections(Source(title="Course", kind="upload", file_path=str(path)))
    assert sections[0][1] == "Page 1"
    assert "def keyword" in sections[0][0]
    assert sections[1][1] == "Page 2"


@pytest.mark.parametrize("hidden", [True, False])
def test_web_extraction_removes_only_hidden_authorization_template(monkeypatch, hidden):
    article = """<h1>Cache-aside</h1>
        <p>Load data on demand into a cache from a data store. Applications first check
        the cache and load missing items from the origin store.</p>
        <h2>Consistency</h2><p>The application must tolerate stale cache entries when
        another process changes the origin store. Expiration limits their lifetime.</p>"""
    html = f"""<html><head><title>Cache-aside</title></head><body><main>
        <div unauthorized-private-section {'hidden' if hidden else ''}>
        <p>Access to this page requires authorization. You can try signing in or changing directories.</p>
        </div><div>{article}</div></main></body></html>"""
    monkeypatch.setattr(evidence, "fetch_document", lambda url: (
        html.encode(), "text/html", url,
    ))
    sections = evidence.document_sections(Source(
        title="Cache", kind="url", url="https://learn.microsoft.com/example",
    ))
    assert "Load data on demand" in sections[0][0]
    assert "Expiration limits" in sections[0][0]
    assert ("requires authorization" in sections[0][0]) is not hidden


def test_hidden_template_alone_is_not_readable_source_material(monkeypatch):
    html = b"""<html><body><div unauthorized-private-section hidden>
        <p>Access to this page requires authorization. You can try signing in or changing directories.</p>
        </div></body></html>"""
    monkeypatch.setattr(evidence, "fetch_document", lambda url: (html, "text/html", url))
    with pytest.raises(HTTPException, match="No readable article text"):
        evidence.document_sections(Source(
            title="Unavailable", kind="url", url="https://learn.microsoft.com/example",
        ))


def test_indexing_failure_preserves_prior_chunks(session, monkeypatch):
    source = Source(title="Notes", kind="text", content="Functions use def.", status="ready", chunk_count=1)
    session.add(source)
    session.commit()
    prior = Chunk(source_id=source.id, content="Previous excerpt", profile="old:2", embedding=[1, 0])
    session.add(prior)
    session.commit()

    def fail(*args):
        raise HTTPException(503, "Embedding provider unavailable.")

    monkeypatch.setattr(evidence, "embed_texts", fail)
    evidence.index_source(session, source)
    session.refresh(source)
    assert source.status == "failed"
    assert source.error == "Embedding provider unavailable."
    assert session.get(Chunk, prior.id).content == "Previous excerpt"


def test_retrieval_is_path_scoped_and_filters_embedding_profiles(session, monkeypatch):
    path = LearningPath(title="Python", input="Python")
    other_path = LearningPath(title="Private other course", input="Other")
    session.add_all([path, other_path])
    session.commit()
    supplied = Source(path_id=path.id, title="My course", kind="text", status="ready")
    other = Source(path_id=other_path.id, title="Other course", kind="text", status="ready")
    old = Source(path_id=path.id, title="Old embedding", kind="text", status="ready")
    web = Source(path_id=path.id, title="Web course", kind="web", status="ready")
    session.add_all([supplied, other, old, web])
    session.commit()
    session.add_all([
        Chunk(source_id=supplied.id, content="Supplied Python functions", profile="test:3", embedding=[1, 0.1, 0]),
        Chunk(source_id=other.id, content="Secret other-path content", profile="test:3", embedding=[1, 0, 0]),
        Chunk(source_id=old.id, content="Wrong dimensions", profile="old:2", embedding=[1, 0]),
        Chunk(source_id=web.id, content="Web functions", profile="test:3", embedding=[1, 0, 0]),
    ])
    session.commit()
    monkeypatch.setattr(evidence, "embed_texts", lambda texts: ([[1, 0, 0]], "test:3"))
    monkeypatch.setattr(evidence, "web_sources", lambda *args: pytest.fail("Supplied source has priority"))
    result = evidence.retrieve_evidence(session, "Python functions", path_id=path.id)
    assert [item["source_id"] for item in result["evidence"]] == [supplied.id, web.id]
    assert result["web_search_performed"] is False
    assert result["evidence"][0]["excerpt"] == "Supplied Python functions"


def test_preferred_source_problems_are_named_when_web_evidence_is_used(session, monkeypatch):
    path = LearningPath(title="Functions", input="Functions")
    session.add(path)
    session.commit()
    pending = Source(path_id=path.id, title="Uploaded outline", kind="upload", status="pending")
    processing = Source(path_id=path.id, title="Course handbook", kind="upload", status="processing")
    failed = Source(path_id=path.id, title="Scanned notes", kind="upload", status="failed",
                    error="No extractable text was found.")
    stale = Source(path_id=path.id, title="Old course notes", kind="text", status="ready")
    web = Source(path_id=path.id, title="Web documentation", kind="web", status="ready")
    session.add_all([pending, processing, failed, stale, web])
    session.commit()
    session.add_all([
        Chunk(source_id=stale.id, content="Old notes", profile="old:2", embedding=[1, 0]),
        Chunk(source_id=web.id, content="Functions use def.", profile="test:3", embedding=[1, 0, 0]),
    ])
    session.commit()
    monkeypatch.setattr(evidence, "embed_texts", lambda texts: ([[1, 0, 0]], "test:3"))
    monkeypatch.setattr(evidence, "web_sources", lambda *args: pytest.fail("Cached web evidence is available"))
    result = evidence.retrieve_evidence(session, "Functions", path_id=path.id)
    warnings = " ".join(result["warnings"])
    assert '"Uploaded outline" is still pending' in warnings
    assert '"Course handbook" is still processing' in warnings
    assert '"Scanned notes" failed to index' in warnings
    assert "No extractable text" in warnings
    assert '"Old course notes" uses a different embedding profile' in warnings
    assert result["web_search_performed"] is False
    assert [item["source_id"] for item in result["evidence"]] == [web.id]


def test_source_list_and_detail_report_reindex_needed_until_reindexed(client, session, monkeypatch):
    source = Source(title="Course notes", kind="text", content="Functions use def.", status="ready", chunk_count=1)
    session.add(source)
    session.commit()
    session.add(Chunk(source_id=source.id, content=source.content, profile="old:2", embedding=[1, 0]))
    session.commit()
    monkeypatch.setattr(ai, "embedding_profile", lambda: ("fixture", "model", 3, "test:3"))
    monkeypatch.setattr(evidence, "embed_texts", lambda texts: ([[1, 0, 0] for _ in texts], "test:3"))
    assert client.get("/api/sources").json()[0]["needs_reindex"] is True
    assert client.get(f"/api/sources/{source.id}").json()["needs_reindex"] is True
    assert client.post(f"/api/sources/{source.id}/retry").status_code == 202
    session.expire_all()
    assert client.get("/api/sources").json()[0]["needs_reindex"] is False
    assert client.get(f"/api/sources/{source.id}").json()["needs_reindex"] is False


def test_recovery_indexes_interrupted_sources(db_engine, session, monkeypatch):
    source = Source(title="Recovered", kind="text", content="Functions use def.", status="processing")
    session.add(source)
    session.commit()
    monkeypatch.setattr(evidence, "engine", db_engine)
    monkeypatch.setattr(evidence, "embed_texts", lambda texts: ([[1, 0, 0] for _ in texts], "test:3"))
    evidence.recover_pending_sources()
    session.refresh(source)
    assert source.status == "ready"
    assert source.chunk_count == 1


def test_source_api_indexes_real_parser_output(client, monkeypatch):
    monkeypatch.setattr(evidence, "embed_texts", lambda texts: ([[1, 0, 0] for _ in texts], "test:3"))
    response = client.post("/api/sources/upload", files={
        "file": ("guide.md", b"# Python\n\nFunctions use def.\n", "text/markdown"),
    })
    assert response.status_code == 202
    source_id = response.json()["id"]
    detail = client.get(f"/api/sources/{source_id}").json()
    assert detail["status"] == "ready"
    assert "Functions use def" in detail["excerpts"][0]["excerpt"]
    assert "file_path" not in detail
    assert "content" not in detail
    assert client.delete(f"/api/sources/{source_id}").status_code == 204


@pytest.mark.parametrize("legacy_absolute_path", [False, True])
def test_uploaded_source_reindexes_and_deletes_after_data_directory_relocation(
    client, session, monkeypatch, tmp_path, legacy_absolute_path,
):
    from trellis.config import settings

    monkeypatch.setattr(evidence, "embed_texts", lambda texts: ([[1, 0, 0] for _ in texts], "test:3"))
    response = client.post("/api/sources/upload", files={
        "file": ("guide.md", b"Functions use def.", "text/markdown"),
    })
    assert response.status_code == 202
    source_id = response.json()["id"]
    source = session.get(Source, source_id)
    assert source.file_path == f"sources/{source_id}.md"
    original_file = settings.data_dir / source.file_path
    relocated_directory = tmp_path / "relocated"
    (relocated_directory / "sources").mkdir(parents=True)
    relocated_file = relocated_directory / "sources" / Path(source.file_path).name
    shutil.copyfile(original_file, relocated_file)
    original_file.write_text("Old absolute location must not be read or deleted.")
    if legacy_absolute_path:
        source.file_path = str(original_file)
        session.add(source)
        session.commit()
    monkeypatch.setattr(settings, "data_dir", relocated_directory)

    assert client.post(f"/api/sources/{source_id}/retry").status_code == 202
    session.expire_all()
    detail = client.get(f"/api/sources/{source_id}").json()
    assert detail["status"] == "ready"
    assert detail["excerpts"][0]["excerpt"] == "Functions use def."
    assert client.delete(f"/api/sources/{source_id}").status_code == 204
    assert not relocated_file.exists()
    assert original_file.exists()


def test_unattached_retrieval_cannot_select_another_paths_sources(session, monkeypatch):
    path = LearningPath(title="Private course", input="Private")
    session.add(path)
    session.commit()
    source = Source(path_id=path.id, title="Private", kind="text", status="ready")
    session.add(source)
    session.commit()
    with pytest.raises(HTTPException) as error:
        evidence.retrieve_evidence(session, "Python", source_ids=[source.id])
    assert error.value.status_code == 409
    assert session.exec(select(Chunk)).all() == []
