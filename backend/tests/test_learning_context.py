import json

from trellis import ai, evidence
from trellis.models import Interaction, LearningPath, Node, Thread


QPS_PASSAGE = {
    "id": "qps-passage", "source_id": "qps-source", "title": "Queries per second",
    "url": "https://example.org/qps", "excerpt": "QPS measures queries processed per second.",
    "location": "Article", "kind": "web",
}


def test_thread_followup_uses_one_resolved_question_for_retrieval_draft_and_review(
    client, session, monkeypatch,
):
    path = LearningPath(title="System design", input="Learn system design")
    session.add(path)
    session.commit()
    node = Node(path_id=path.id, title="Horizontal scaling and bottleneck analysis")
    session.add(node)
    session.commit()
    thread = Thread(path_id=path.id, node_id=node.id, title="QPS", seed_context="Explore QPS")
    unrelated = Thread(path_id=path.id, node_id=node.id, title="Private sibling topic")
    session.add_all([thread, unrelated])
    session.commit()
    history = Interaction(
        path_id=path.id, node_id=node.id, thread_id=thread.id,
        prompt="What is QPS?", content="QPS means queries per second.",
    )
    session.add_all([
        history,
        Interaction(path_id=path.id, node_id=node.id, prompt="Primary scaling question",
                    content="Primary-only explanation"),
        Interaction(path_id=path.id, node_id=node.id, thread_id=unrelated.id,
                    prompt="Private sibling question", content="Private sibling explanation"),
    ])
    session.commit()
    node_id, thread_id, path_id = node.id, thread.id, path.id
    before = client.get(f"/api/nodes/{node_id}").json()
    resolved = "Explain queries per second (QPS) in more detail."
    search_query = "queries per second QPS measurement"
    stages = []
    retrievals = []

    def retrieve(session, query, **kwargs):
        retrievals.append((query, kwargs))
        return {"evidence": [QPS_PASSAGE], "warnings": [], "web_search_performed": False}

    def complete(provider, model, schema, messages):
        request = json.loads(messages[1]["content"])
        stages.append((schema, request))
        assert "Primary-only explanation" not in json.dumps(request)
        assert "Private sibling" not in json.dumps(request)
        if schema is ai.ResolvedQuestion:
            assert "Explain more" in json.dumps(request)
            assert request["context"]["thread_title"] == "QPS"
            assert request["context"]["history"][0]["prompt"] == "What is QPS?"
            return ai.ResolvedQuestion(question=resolved, search_query=search_query, sources_only=False)
        assert request["question"] == resolved
        assert request["context"]["active_topic"] == "QPS"
        assert request["context"]["scope"] == "thread"
        if schema is ai.DraftAnswer:
            return ai.DraftAnswer(status="answered", reason="", blocks=[
                ai.AnswerBlock(text=QPS_PASSAGE["excerpt"], evidence_ids=[QPS_PASSAGE["id"]]),
            ])
        assert schema is ai.AnswerEvaluation
        return ai.AnswerEvaluation(
            relevance=1, completeness=1, consistency=1, grounding=1, supported=True,
            explanation="The cited definition explains the active QPS discussion.",
        )

    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(ai, "structured_completion", complete)
    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)
    response = client.post(f"/api/threads/{thread_id}/interactions", json={"prompt": "Explain more"})
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["status"] == "answered"
    assert result["prompt"] == "Explain more"
    assert result["evaluation"]["resolved_question"] == resolved
    assert result["evaluation"]["active_topic"] == "QPS"
    assert retrievals == [(search_query, {"path_id": path_id})]
    assert [schema for schema, _ in stages] == [
        ai.ResolvedQuestion, ai.DraftAnswer, ai.AnswerEvaluation,
    ]
    assert stages[1][1]["context"] == stages[2][1]["context"]
    after = client.get(f"/api/nodes/{node_id}").json()
    assert after["node"] == before["node"]
    assert after["interactions"] == before["interactions"]
    session.expire_all()
    assert session.get(Interaction, result["id"]).evaluation["active_topic"] == "QPS"


def test_node_followup_keeps_its_topic_when_no_thread_is_active(monkeypatch):
    context = {"path_id": "journey", "path_title": "System design", "node_title": "QPS",
               "history": [{"prompt": "What is QPS?", "content": "Queries per second."}]}
    original_context = json.loads(json.dumps(context))
    requests = []

    def complete(provider, model, schema, messages):
        request = json.loads(messages[1]["content"])
        requests.append((schema, request))
        if schema is ai.ResolvedQuestion:
            return ai.ResolvedQuestion(
                question="Explain QPS in more detail.", search_query="QPS definition", sources_only=False,
            )
        assert request["context"]["active_topic"] == "QPS"
        assert request["context"]["scope"] == "node"
        assert request["question"] == "Explain QPS in more detail."
        if schema is ai.DraftAnswer:
            return ai.DraftAnswer(status="answered", reason="", blocks=[
                ai.AnswerBlock(text=QPS_PASSAGE["excerpt"], evidence_ids=[QPS_PASSAGE["id"]]),
            ])
        return ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                                   supported=True, explanation="Definition is supported.")

    monkeypatch.setattr(ai, "selected_provider", lambda session: ("ollama", "test-model"))
    monkeypatch.setattr(ai, "structured_completion", complete)
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [QPS_PASSAGE], "warnings": [], "web_search_performed": False,
    })
    result = ai.answer(None, context, "Explain more")
    assert result["status"] == "answered"
    assert context == original_context
    assert requests[1][1]["context"] == requests[2][1]["context"]


def test_selected_answer_sets_the_topic_for_retrieval_draft_and_review(monkeypatch):
    selected_prompt = "Are there other model training methods?"
    selected_question = "How do supervised fine-tuning and RLHF teach a model?"
    context = {
        "path_id": "journey", "node_title": "Fine-Tuning",
        "history": [{"prompt": selected_prompt, "content": "Methods include SFT and RLHF."}],
        "focus_interaction": {
            "prompt": selected_prompt, "content": "Methods include SFT and RLHF.",
            "status": "answered",
            "resolved_question": selected_question,
        },
        "answer_action": "simplify",
    }
    passage = {
        **QPS_PASSAGE, "id": "method-passage", "title": "Training methods",
        "excerpt": "Supervised fine-tuning uses labelled examples. RLHF uses human feedback.",
    }
    resolved = "Explain SFT and RLHF training methods in more depth."
    search_query = "SFT RLHF training methods"
    requests = []
    retrievals = []

    def complete(provider, model, schema, messages):
        request = json.loads(messages[1]["content"])
        requests.append((schema, request))
        if schema is ai.ResolvedQuestion:
            assert request["context"]["focus_interaction"]["prompt"] == selected_prompt
            return ai.ResolvedQuestion(
                question=resolved, search_query=search_query, sources_only=False,
            )
        assert request["question"] == resolved
        assert request["context"]["active_topic"] == selected_question
        if schema is ai.DraftAnswer:
            return ai.DraftAnswer(status="answered", reason="", blocks=[
                ai.AnswerBlock(text=passage["excerpt"], evidence_ids=[passage["id"]]),
            ])
        return ai.AnswerEvaluation(relevance=1, completeness=1, consistency=1, grounding=1,
                                   supported=True, explanation="Both claims are in the passage.")

    def retrieve(session, query, **kwargs):
        retrievals.append((query, kwargs))
        return {"evidence": [passage], "warnings": [], "web_search_performed": False}

    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(ai, "structured_completion", complete)
    monkeypatch.setattr(evidence, "retrieve_evidence", retrieve)

    result = ai.answer(None, context, "Explain the selected answer simply")

    assert result["status"] == "answered"
    assert result["evaluation"]["active_topic"] == selected_question
    assert retrievals == [(search_query, {"path_id": "journey"})]
    assert [schema for schema, _ in requests] == [
        ai.ResolvedQuestion, ai.DraftAnswer, ai.AnswerEvaluation,
    ]
    assert requests[1][1]["context"] == requests[2][1]["context"]


def test_source_constraint_resolved_from_followup_history_prevents_general_fallback(monkeypatch):
    context = {
        "path_id": "journey", "node_title": "Horizontal scaling", "thread_title": "QPS",
        "thread_id": "thread", "history": [{
            "prompt": "Explain QPS using only my uploaded notes.",
            "content": "The uploaded notes do not define QPS.",
        }],
    }
    requests = []

    def complete(provider, model, schema, messages):
        requests.append(schema)
        assert schema is ai.ResolvedQuestion
        request = json.loads(messages[1]["content"])
        assert "using only my uploaded notes" in json.dumps(request)
        return ai.ResolvedQuestion(
            question="Explain QPS in more detail using only the uploaded notes.",
            search_query="QPS queries per second", sources_only=True,
        )

    monkeypatch.setattr(ai, "selected_provider", lambda session: ("azure", "test-model"))
    monkeypatch.setattr(ai, "structured_completion", complete)
    monkeypatch.setattr(evidence, "retrieve_evidence", lambda *args, **kwargs: {
        "evidence": [], "warnings": ["No usable sources."], "web_search_performed": True,
    })
    result = ai.answer(None, context, "Explain more")
    assert result["status"] == "abstained"
    assert result["evaluation"]["resolved_question"].endswith("using only the uploaded notes.")
    assert requests == [ai.ResolvedQuestion]
