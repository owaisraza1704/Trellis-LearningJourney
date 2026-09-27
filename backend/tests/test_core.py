import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from trellis import ai, core
from trellis.models import Interaction, LearningPath, Node, Thread


def create_path(client, title="Learn Python"):
    response = client.post("/api/paths", json={"input": title})
    assert response.status_code == 201, response.text
    return response.json()


def test_empty_workspace_has_explicit_resume_location(client):
    result = client.get("/api/workspace")
    assert result.status_code == 200
    assert result.json()["location"] == {"path_id": None, "node_id": None, "thread_id": None}


def test_curriculum_edits_reorder_and_progress_survive_new_client(client, stub_ai):
    path = create_path(client)
    first, second, third = [node["id"] for node in path["nodes"]]
    assert client.patch(f"/api/nodes/{second}/progress", json={"status": "completed"}).status_code == 200
    assert client.patch(f"/api/nodes/{second}", json={"title": "Python lists"}).status_code == 200
    reordered = client.post(f"/api/paths/{path['id']}/reorder", json={"node_ids": [first, third, second]})
    assert reordered.status_code == 200
    reopened = TestClient(client.app).get(f"/api/paths/{path['id']}").json()
    assert [node["id"] for node in reopened["nodes"]] == [first, third, second]
    assert reopened["nodes"][2]["title"] == "Python lists"
    assert reopened["nodes"][2]["status"] == "completed"
    assert reopened["progress"] == 33
    client.post(f"/api/nodes/{second}/interactions", json={"prompt": "Explain this node"})
    assert stub_ai[-1]["node_position"] == 2
    assert stub_ai[-1]["node_count"] == 3


def test_learning_action_reaches_answer_service(client, stub_ai):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    response = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Explain this topic in more depth", "action": "deeper",
    })
    assert response.status_code == 201
    assert response.json()["action"] == "deeper"
    assert stub_ai[-1]["answer_action"] == "deeper"


def test_followup_uses_the_selected_answer_and_only_its_earlier_history(client, stub_ai):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    client.post(f"/api/nodes/{node_id}/interactions", json={"prompt": "Which methods teach a model?"})
    selected = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Are there other training methods?",
    }).json()
    client.post(f"/api/nodes/{node_id}/interactions", json={"prompt": "What is prompt design?"})

    response = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Go deeper into the answer to: Are there other training methods?",
        "action": "deeper", "reply_to_interaction_id": selected["id"],
    })

    assert response.status_code == 201
    context = stub_ai[-1]
    assert [item["prompt"] for item in context["history"]] == [
        "Which methods teach a model?", "Are there other training methods?",
    ]
    assert context["focus_interaction"] == {
        "prompt": selected["prompt"], "content": selected["content"], "status": "answered",
        "resolved_question": selected["prompt"],
    }
    assert context["answer_action"] == "deeper"
    assert response.json()["reply_to_interaction_id"] == selected["id"]


def test_followup_of_a_followup_uses_the_visible_answer(client, session, stub_ai):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    first = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Introduce RAG architectures.",
    }).json()
    second = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Go deeper into RAG architectures.", "action": "deeper",
        "reply_to_interaction_id": first["id"],
    }).json()
    saved_second = session.get(Interaction, second["id"])
    saved_second.evaluation = {"resolved_question": "How does a retriever rank passages?"}
    session.add(saved_second)
    session.commit()

    third = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Go deeper into the answer to: How does a retriever rank passages?",
        "action": "deeper", "reply_to_interaction_id": second["id"],
    })

    assert third.status_code == 201
    assert third.json()["reply_to_interaction_id"] == second["id"]
    assert stub_ai[-1]["focus_interaction"] == {
        "prompt": second["prompt"], "content": second["content"], "status": "answered",
        "resolved_question": "How does a retriever rank passages?",
    }


def test_followup_cannot_target_another_conversation_or_withheld_answer(client, session, stub_ai):
    path = create_path(client)
    first_node, second_node = [item["id"] for item in path["nodes"][:2]]
    primary = client.post(f"/api/nodes/{first_node}/interactions", json={
        "prompt": "Primary question",
    }).json()
    thread = client.post(f"/api/nodes/{first_node}/threads", json={"title": "Methods"}).json()
    thread_answer = client.post(f"/api/threads/{thread['id']}/interactions", json={
        "prompt": "Thread question",
    }).json()
    withheld = Interaction(path_id=path["id"], node_id=first_node, prompt="Unsupported",
                           content="No supported answer", status="abstained")
    session.add(withheld)
    session.commit()

    for endpoint, target in (
        (f"/api/nodes/{second_node}/interactions", primary["id"]),
        (f"/api/nodes/{first_node}/interactions", thread_answer["id"]),
        (f"/api/threads/{thread['id']}/interactions", primary["id"]),
        (f"/api/nodes/{first_node}/interactions", withheld.id),
    ):
        response = client.post(endpoint, json={
            "prompt": "Go deeper", "action": "deeper", "reply_to_interaction_id": target,
        })
        assert response.status_code == 422

    followed = client.post(f"/api/threads/{thread['id']}/interactions", json={
        "prompt": "Show an example", "action": "example",
        "reply_to_interaction_id": thread_answer["id"],
    })
    assert followed.status_code == 201
    assert [item["prompt"] for item in stub_ai[-1]["history"]] == ["Thread question"]
    assert stub_ai[-1]["focus_interaction"]["prompt"] == "Thread question"


def test_streamed_answer_reveals_content_only_after_checks_and_save(client, stub_ai, session):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    with client.stream("POST", f"/api/nodes/{node_id}/interactions",
                       headers={"Accept": "application/x-ndjson"},
                       json={"prompt": "Explain this topic", "action": "foundation"}) as response:
        assert response.status_code == 201
        assert response.headers["content-type"].startswith("application/x-ndjson")
        events = [json.loads(line) for line in response.iter_lines() if line]

    assert [event["stage"] for event in events if event["type"] == "progress"] == [
        "understanding", "finding_sources", "writing", "checking", "saving",
    ]
    assert events[-1]["type"] == "done"
    assert next(index for index, event in enumerate(events)
                if event["type"] == "answer_delta") > next(
        index for index, event in enumerate(events)
        if event == {"type": "progress", "stage": "saving"}
    )
    text = "".join(event["text"] for event in events if event["type"] == "answer_delta")
    assert text == events[-1]["interaction"]["content"]
    assert session.get(Interaction, events[-1]["interaction"]["id"]).content == text
    assert stub_ai[-1]["answer_action"] == "foundation"


def test_streamed_answer_reports_failure_without_saving(client, stub_ai, session, monkeypatch):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]

    def unavailable(session, context, prompt, progress=None):
        raise HTTPException(503, "The model is unavailable.")

    monkeypatch.setattr(ai, "answer", unavailable)
    with client.stream("POST", f"/api/nodes/{node_id}/interactions",
                       headers={"Accept": "application/x-ndjson"},
                       json={"prompt": "Explain this topic"}) as response:
        events = [json.loads(line) for line in response.iter_lines() if line]

    assert events == [{"type": "error", "message": "The model is unavailable.", "status": 503}]
    assert session.exec(select(Interaction)).all() == []


def test_streamed_thread_answer_stays_in_its_thread(client, stub_ai):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    thread = client.post(f"/api/nodes/{node_id}/threads", json={"title": "Related thought"}).json()
    with client.stream("POST", f"/api/threads/{thread['id']}/interactions",
                       headers={"Accept": "application/x-ndjson"},
                       json={"prompt": "Explain this thought"}) as response:
        events = [json.loads(line) for line in response.iter_lines() if line]

    answer = events[-1]["interaction"]
    assert answer["thread_id"] == thread["id"]
    assert client.get(f"/api/nodes/{node_id}").json()["interactions"] == []
    assert [item["id"] for item in client.get(f"/api/threads/{thread['id']}").json()["interactions"]] == [answer["id"]]
    assert stub_ai[-1]["thread_title"] == "Related thought"


def test_group_status_follows_leaf_progress_and_groups_cannot_be_studied(client, stub_ai):
    path = create_path(client)
    group, another_leaf, _ = [node["id"] for node in path["nodes"]]
    first = client.post(f"/api/paths/{path['id']}/nodes", json={
        "title": "First subtopic", "parent_id": group,
    }).json()["id"]
    nested_group = client.post(f"/api/paths/{path['id']}/nodes", json={
        "title": "Nested group", "parent_id": group,
    }).json()["id"]
    nested_leaf = client.post(f"/api/paths/{path['id']}/nodes", json={
        "title": "Nested subtopic", "parent_id": nested_group,
    }).json()["id"]

    def snapshot():
        detail = client.get(f"/api/paths/{path['id']}").json()
        return detail, {node["id"]: node["status"] for node in detail["nodes"]}

    detail, statuses = snapshot()
    assert detail["node_count"] == 4
    assert detail["progress"] == 0
    assert statuses[group] == statuses[nested_group] == "not_started"
    for route, method, body in (
        (f"/api/nodes/{group}", "get", None),
        (f"/api/nodes/{group}/progress", "patch", {"status": "completed"}),
        (f"/api/nodes/{group}/interactions", "post", {"prompt": "Study parent"}),
        (f"/api/nodes/{group}/threads", "post", {"title": "Group thread"}),
        ("/api/location", "put", {"path_id": path["id"], "node_id": group}),
    ):
        assert client.request(method, route, json=body).status_code == 409

    assert client.patch(f"/api/nodes/{first}/progress", json={"status": "completed"}).status_code == 200
    detail, statuses = snapshot()
    assert statuses[group] == "in_progress"
    assert statuses[nested_group] == "not_started"
    assert detail["completed_count"] == 1 and detail["progress"] == 25
    assert client.get("/api/paths").json()[0]["progress"] == 25

    assert client.patch(f"/api/nodes/{nested_leaf}/progress", json={"status": "in_progress"}).status_code == 200
    _, statuses = snapshot()
    assert statuses[group] == statuses[nested_group] == "in_progress"
    assert client.patch(f"/api/nodes/{nested_leaf}/progress", json={"status": "completed"}).status_code == 200
    detail, statuses = snapshot()
    assert statuses[group] == statuses[nested_group] == "completed"
    assert detail["completed_count"] == 2 and detail["progress"] == 50
    assert client.patch(f"/api/nodes/{another_leaf}/progress", json={"status": "completed"}).status_code == 200
    assert client.get("/api/paths").json()[0]["completed_count"] == 3


def test_studied_leaf_cannot_be_converted_into_a_group(client, stub_ai):
    path = create_path(client)
    studied, candidate = [node["id"] for node in path["nodes"][:2]]
    assert client.patch(f"/api/nodes/{studied}/progress", json={"status": "in_progress"}).status_code == 200
    assert client.post(f"/api/paths/{path['id']}/nodes", json={
        "title": "New child", "parent_id": studied,
    }).status_code == 409
    assert client.patch(f"/api/nodes/{candidate}", json={"parent_id": studied}).status_code == 409
    assert client.get(f"/api/nodes/{studied}").status_code == 200


@pytest.mark.parametrize("manual_status", [None, "completed", "in_progress"])
def test_first_answer_respects_progress_changed_while_generating(
    client, db_engine, stub_ai, monkeypatch, manual_status,
):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    answer = ai.answer

    def answer_while_progress_changes(session, context, prompt):
        assert session.get(Node, node_id).status == "not_started"
        if manual_status:
            # The learner's separate request commits while answer generation is pending.
            with Session(db_engine) as progress_session:
                core.update_progress(node_id, core.ProgressInput(status=manual_status), progress_session)
        return answer(session, context, prompt)

    monkeypatch.setattr(ai, "answer", answer_while_progress_changes)
    response = client.post(f"/api/nodes/{node_id}/interactions", json={"prompt": "Explain this topic"})
    assert response.status_code == 201
    with Session(db_engine) as reopened:
        assert reopened.get(Node, node_id).status == (manual_status or "in_progress")
        interaction = reopened.get(Interaction, response.json()["id"])
        assert interaction.node_id == node_id
        assert interaction.status == "answered"


def test_multiple_nodes_and_threads_never_mix_histories(client, stub_ai):
    path = create_path(client)
    node_a, node_b = [node["id"] for node in path["nodes"][:2]]
    main = client.post(f"/api/nodes/{node_a}/interactions", json={"prompt": "Primary question"}).json()
    client.post(f"/api/nodes/{node_b}/interactions", json={"prompt": "Other node secret"})
    thread_a = client.post(f"/api/nodes/{node_a}/threads", json={"title": "Tangent A", "interaction_id": main["id"]}).json()
    thread_b = client.post(f"/api/nodes/{node_a}/threads", json={"title": "Tangent B"}).json()
    location = {"path_id": path["id"], "node_id": node_a, "thread_id": None}
    client.put("/api/location", json=location)
    before = client.get(f"/api/nodes/{node_a}").json()
    client.post(f"/api/threads/{thread_a['id']}/interactions", json={"prompt": "Thread A secret"})
    client.post(f"/api/threads/{thread_b['id']}/interactions", json={"prompt": "Thread B secret"})
    client.post(f"/api/threads/{thread_a['id']}/interactions", json={"prompt": "Continue A"})
    context = stub_ai[-1]
    assert [item["prompt"] for item in context["history"]] == ["Thread A secret"]
    assert "Primary question" in context["seed_context"]
    after = client.get(f"/api/nodes/{node_a}").json()
    assert after["interactions"] == before["interactions"]
    assert after["node"] == before["node"]
    assert client.get("/api/workspace").json()["location"] == location
    client.post(f"/api/nodes/{node_a}/interactions", json={"prompt": "Back to primary"})
    assert [item["prompt"] for item in stub_ai[-1]["history"]] == ["Primary question"]


def test_resume_thread_and_closed_thread_rules(client, stub_ai):
    path = create_path(client)
    node = path["nodes"][0]["id"]
    thread = client.post(f"/api/nodes/{node}/threads", json={"title": "Exploration"}).json()
    location = {"path_id": path["id"], "node_id": node, "thread_id": thread["id"]}
    assert client.put("/api/location", json=location).status_code == 200
    assert TestClient(client.app).get("/api/workspace").json()["location"] == location
    assert len(client.get("/api/learning-sessions").json()) == 1
    start = client.get("/api/learning-sessions").json()[0]["last_active_at"]
    client.patch(f"/api/nodes/{node}/progress", json={"status": "not_started"})
    assert client.get("/api/learning-sessions").json()[0]["last_active_at"] > start
    assert client.post("/api/learning-sessions/end").json()["ended_at"]
    client.patch(f"/api/threads/{thread['id']}", json={"status": "closed"})
    assert client.post(f"/api/threads/{thread['id']}/interactions", json={"prompt": "Hello"}).status_code == 409
    client.patch(f"/api/threads/{thread['id']}", json={"status": "open"})
    assert client.post(f"/api/threads/{thread['id']}/interactions", json={"prompt": "Hello"}).status_code == 201
    assert client.get(f"/api/nodes/{node}").json()["node"]["status"] == "not_started"


def test_invalid_relationships_and_destructive_edits_are_rejected(client, stub_ai):
    path = create_path(client)
    other = create_path(client, "Learn SQL")
    parent, _, leaf = [node["id"] for node in path["nodes"]]
    child = client.post(f"/api/paths/{path['id']}/nodes", json={
        "title": "A child topic", "parent_id": parent,
    }).json()["id"]
    foreign = other["nodes"][0]["id"]
    assert client.patch(f"/api/nodes/{parent}", json={"parent_id": child}).status_code == 422
    assert client.patch(f"/api/nodes/{child}", json={"parent_id": foreign}).status_code == 422
    assert client.put("/api/location", json={"path_id": path["id"], "node_id": foreign}).status_code == 422
    assert client.post(f"/api/paths/{path['id']}/reorder", json={"node_ids": [parent, child, child]}).status_code == 422
    assert client.delete(f"/api/nodes/{parent}").status_code == 409
    client.post(f"/api/nodes/{child}/interactions", json={"prompt": "Explain"})
    assert client.delete(f"/api/nodes/{child}").status_code == 409
    assert client.delete(f"/api/nodes/{leaf}").status_code == 204


def test_failed_generation_preserves_prior_state(client, session, stub_ai, monkeypatch):
    path = create_path(client)
    node = path["nodes"][0]["id"]
    client.post(f"/api/nodes/{node}/interactions", json={"prompt": "Explain"})
    def fail(*args):
        raise HTTPException(503, "Provider unavailable")
    monkeypatch.setattr(ai, "answer", fail)
    assert client.post(f"/api/nodes/{node}/interactions", json={"prompt": "Continue"}).status_code == 503
    assert len(session.exec(select(Interaction)).all()) == 1
    assert len(client.get(f"/api/nodes/{node}").json()["interactions"]) == 1


def test_malformed_curriculum_never_creates_partial_path(client, session, stub_ai, monkeypatch):
    monkeypatch.setattr(ai, "generate_curriculum", lambda *args: {
        "title": "Invalid", "nodes": [{"title": "Loop", "parent_index": 0}]})
    assert client.post("/api/paths", json={"input": "Learn Python"}).status_code == 502
    assert session.exec(select(LearningPath)).all() == []
    assert client.post("/api/paths", json={"input": "   "}).status_code == 422


def test_overview_preserves_last_study_location_and_switching_paths_restores_it(client, stub_ai):
    first = create_path(client)
    node_id = first["nodes"][1]["id"]
    thread = client.post(f"/api/nodes/{node_id}/threads", json={"title": "Tuple comparisons"}).json()
    location = {"path_id": first["id"], "node_id": node_id, "thread_id": thread["id"]}
    assert client.put("/api/location", json=location).json() == location
    assert client.put("/api/location", json={"path_id": first["id"]}).json() == location
    detail = client.get("/api/workspace").json()["location_detail"]
    assert detail == {"path_title": "Learn Python", "node_title": "Sequences",
                      "thread_title": "Tuple comparisons"}

    second = create_path(client, "Learn databases")
    other_location = {"path_id": second["id"], "node_id": second["nodes"][0]["id"], "thread_id": None}
    client.put("/api/location", json=other_location)
    assert client.put("/api/location", json={"path_id": first["id"]}).json() == location
    periods = client.get("/api/learning-sessions").json()
    assert len([period for period in periods if period["ended_at"] is None]) == 1
    assert client.put("/api/location", json={"path_id": first["id"], "node_id": None}).json() == {
        "path_id": first["id"], "node_id": None, "thread_id": None,
    }


def test_curriculum_evidence_snapshot_survives_node_edits(client, stub_ai, monkeypatch):
    draft = ai.generate_curriculum(None, "Learn Python", "goal", [])
    evidence = [{"id": "E1", "title": "Python documentation", "excerpt": "Lists hold items."}]
    generation = {"mode": "goal", "provider": "test", "model": "fixture", "evidence": evidence,
                  "evaluation": {"status": "passed", "supported": True}, "created_at": "2026-09-25T00:00:00Z"}
    draft["generation"] = generation
    draft["nodes"][0]["evidence_ids"] = ["E1"]
    monkeypatch.setattr(ai, "generate_curriculum", lambda *args: draft)
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    client.patch(f"/api/nodes/{node_id}", json={"title": "My foundation notes"})
    loaded = TestClient(client.app).get(f"/api/paths/{path['id']}").json()
    assert loaded["generation"] == generation
    assert loaded["nodes"][0]["evidence_ids"] == ["E1"]
    assert "generation" not in client.get("/api/paths").json()[0]


def test_legacy_abstention_diagnostics_are_not_reused_as_teaching_history(client, session, stub_ai):
    path = create_path(client)
    node = session.get(Node, path["nodes"][0]["id"])
    session.add(Interaction(path_id=path["id"], node_id=node.id, prompt="Explain more",
                            content="Internal review: raw UUID and unsupported comparison.", status="abstained"))
    session.commit()
    context = core.build_context(session, node)
    assert context["history"][0]["prompt"] == "Explain more"
    assert "withheld" in context["history"][0]["content"]
    assert "raw UUID" not in context["history"][0]["content"]


def test_new_threads_keep_withheld_questions_without_diagnostic_content(client, session, stub_ai):
    path = create_path(client)
    node_id = path["nodes"][0]["id"]
    source = Interaction(
        path_id=path["id"], node_id=node_id, prompt="Compare these approaches",
        content="Internal review: unsupported claim from 9fd2c6b5-bc5a-49df-8fc4-6f4c6c7b0ec1.",
        status="abstained",
    )
    session.add(source)
    session.commit()
    response = client.post(f"/api/nodes/{node_id}/threads", json={
        "title": "Explore the comparison", "interaction_id": source.id,
    })
    assert response.status_code == 201
    thread = response.json()
    assert source.prompt in thread["seed_context"]
    assert core.WITHHELD_ANSWER in thread["seed_context"]
    assert source.content not in thread["seed_context"]
    result = client.post(f"/api/threads/{thread['id']}/interactions", json={"prompt": "Explain further"})
    assert result.status_code == 201
    assert stub_ai[-1]["seed_context"] == thread["seed_context"]
    assert source.content not in str(stub_ai[-1])
    assert client.get(f"/api/nodes/{node_id}").json()["interactions"][0]["content"] == source.content


def test_legacy_thread_seeds_are_sanitized_without_changing_accepted_or_saved_content(client, session, stub_ai):
    path = create_path(client)
    node = session.get(Node, path["nodes"][0]["id"])
    sources = [
        Interaction(path_id=path["id"], node_id=node.id, prompt="Explain the comparison",
                    content="Internal review: raw UUID and unsupported comparison.", status="abstained"),
        Interaction(path_id=path["id"], node_id=node.id, prompt="Explain the supported example",
                    content="Accepted, source-supported explanation.", status="answered"),
    ]
    session.add_all(sources)
    session.commit()
    threads = []
    for source in sources:
        seed = (f"Origin topic: {node.title}. {node.description}"
                f"\nStarting question: {source.prompt}\nStarting explanation: {source.content}")
        thread = Thread(path_id=path["id"], node_id=node.id, title=source.prompt, seed_context=seed)
        session.add(thread)
        threads.append(thread)
    # The original response may be older than the current bounded message history.
    for index in range(13):
        session.add(Interaction(path_id=path["id"], node_id=node.id, prompt=f"Later question {index}",
                                content="Later answer", status="answered"))
    session.commit()
    saved_seeds = [thread.seed_context for thread in threads]
    for thread in threads:
        result = client.post(f"/api/threads/{thread.id}/interactions", json={"prompt": "Continue"})
        assert result.status_code == 201
        context = stub_ai[-1]
        assert thread.title in context["seed_context"]
        assert "Internal review:" not in str(context)
    assert core.WITHHELD_ANSWER in stub_ai[-2]["seed_context"]
    assert stub_ai[-1]["seed_context"] == saved_seeds[1]
    for thread, original in zip(threads, saved_seeds, strict=True):
        session.refresh(thread)
        assert thread.seed_context == original
    session.refresh(sources[0])
    assert sources[0].content == "Internal review: raw UUID and unsupported comparison."
