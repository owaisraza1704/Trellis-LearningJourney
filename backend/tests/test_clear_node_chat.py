from sqlmodel import select

from trellis.models import Activity, Interaction, NotebookItem, Source


def test_clearing_node_chat_keeps_other_learning_work(client, session, stub_ai):
    path = client.post("/api/paths", json={"input": "Learn Python"}).json()
    node_id, other_node_id = [node["id"] for node in path["nodes"][:2]]
    first = client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "What are Python functions?",
    }).json()
    client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Show an example", "action": "example",
        "reply_to_interaction_id": first["id"],
    })
    other = client.post(f"/api/nodes/{other_node_id}/interactions", json={
        "prompt": "What are lists?",
    }).json()
    thread = client.post(f"/api/nodes/{node_id}/threads", json={
        "title": "Related thought", "interaction_id": first["id"],
    }).json()
    thread_answer = client.post(f"/api/threads/{thread['id']}/interactions", json={
        "prompt": "What about closures?",
    }).json()
    page = client.post("/api/notebook/pages", json={
        "path_id": path["id"], "title": "Saved work",
    }).json()
    saved = client.post("/api/notebook/items", json={
        "page_id": page["id"], "interaction_id": first["id"],
    }).json()
    source = Source(path_id=path["id"], title="Reference", kind="text", status="ready")
    session.add(source)
    session.commit()
    client.patch(f"/api/nodes/{node_id}/progress", json={"status": "completed"})

    response = client.delete(f"/api/nodes/{node_id}/interactions")

    assert response.status_code == 204, response.text
    detail = client.get(f"/api/nodes/{node_id}").json()
    assert detail["interactions"] == []
    assert detail["node"]["status"] == "completed"
    assert [entry["id"] for entry in detail["threads"]] == [thread["id"]]
    assert [entry["id"] for entry in client.get(f"/api/threads/{thread['id']}").json()[
        "interactions"
    ]] == [thread_answer["id"]]
    assert [entry["id"] for entry in client.get(f"/api/nodes/{other_node_id}").json()[
        "interactions"
    ]] == [other["id"]]
    session.expire_all()
    note = session.get(NotebookItem, saved["id"])
    assert note.content == first["content"]
    assert note.interaction_id is None
    assert "interaction_id" not in note.origin
    assert session.get(Source, source.id).path_id == path["id"]
    assert not session.exec(select(Activity).where(
        Activity.kind == "interaction", Activity.node_id == node_id,
    )).all()
    assert session.exec(select(Activity).where(
        Activity.kind == "notebook_saved", Activity.notebook_item_id == note.id,
    )).one().interaction_id is None

    assert client.delete(f"/api/nodes/{node_id}/interactions").status_code == 204
    assert client.delete("/api/nodes/missing/interactions").status_code == 404
    assert client.post(f"/api/nodes/{node_id}/interactions", json={
        "prompt": "Start a new discussion",
    }).status_code == 201
    assert stub_ai[-1]["history"] == []
    assert session.get(Interaction, first["id"]) is None
