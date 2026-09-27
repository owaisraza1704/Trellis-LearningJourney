from importlib import import_module

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa

from trellis.models import Activity


def test_history_pages_reach_older_activity(client, session):
    session.add_all(Activity(kind='test', label=f'Event {index}') for index in range(25))
    session.commit()

    all_events = client.get('/api/history').json()
    first = client.get('/api/history?limit=13&offset=0').json()
    second = client.get('/api/history?limit=13&offset=12').json()
    third = client.get('/api/history?limit=13&offset=24').json()

    assert len(all_events) == 25
    assert first == all_events[:13]
    assert second == all_events[12:25]
    assert third == all_events[24:]


def test_history_keeps_exact_response_note_and_session_context(client, stub_ai):
    path = client.post('/api/paths', json={'input': 'History destinations'}).json()
    node = path['nodes'][0]
    location = {'path_id': path['id'], 'node_id': node['id'], 'thread_id': None}
    assert client.put('/api/location', json=location).status_code == 200
    first = client.post(f"/api/nodes/{node['id']}/interactions",
                        json={'prompt': 'Same question'}).json()
    second = client.post(f"/api/nodes/{node['id']}/interactions",
                         json={'prompt': 'Same question'}).json()
    thread = client.post(f"/api/nodes/{node['id']}/threads",
                         json={'title': 'Separate exploration', 'interaction_id': first['id']}).json()
    answer = client.post(f"/api/threads/{thread['id']}/interactions",
                         json={'prompt': 'Same question'}).json()
    page = client.post('/api/notebook/pages', json={'path_id': path['id'], 'title': 'Notes'}).json()
    note = client.post('/api/notebook/items', json={
        'page_id': page['id'], 'interaction_id': answer['id'],
    }).json()
    events = client.get('/api/history').json()
    assert {event['interaction_id'] for event in events if event['kind'] == 'interaction'} == {
        first['id'], second['id'],
    }
    saved = next(event for event in events if event['kind'] == 'notebook_saved')
    assert (saved['notebook_item_id'], saved['interaction_id'], saved['thread_id']) == (
        note['id'], answer['id'], thread['id'],
    )
    assert client.delete(f"/api/notebook/items/{note['id']}").status_code == 204
    saved = next(event for event in client.get('/api/history').json()
                 if event['id'] == saved['id'])
    assert saved['notebook_item_id'] is None
    assert saved['interaction_id'] == answer['id']
    period = client.get('/api/learning-sessions').json()[0]
    assert period['path_title'] == path['title']
    assert period['node_title'] == node['title']
    assert period['thread_title'] is None


def test_history_migration_preserves_learning_data_and_ambiguous_legacy_links(client, stub_ai, db_engine, session):
    path = client.post('/api/paths', json={'input': 'Preserved journey'}).json()
    node_id = path['nodes'][0]['id']
    for prompt in ('Repeated', 'Repeated', 'Unique question'):
        assert client.post(f'/api/nodes/{node_id}/interactions', json={'prompt': prompt}).status_code == 201
    page = client.post('/api/notebook/pages', json={'path_id': path['id'], 'title': 'Keep notes'}).json()
    assert client.post('/api/notebook/items', json={
        'page_id': page['id'], 'title': 'Keep this', 'content': 'Original text',
    }).status_code == 201
    session.commit()
    schema = db_engine.get_execution_options()['schema_translate_map'][None]
    migration = import_module('migrations.versions.a47d8e290c61_history_destinations')
    with db_engine.begin() as connection:
        connection.execute(sa.text(f'SET LOCAL search_path TO "{schema}", public'))
        tables = ('learningpath', 'node', 'thread', 'interaction', 'notebookitem', 'notebookpage',
                  'studyset', 'exportrecord', 'workspace', 'learningsession')
        before = {table: connection.execute(sa.text(f'SELECT * FROM {table} ORDER BY id')).all()
                  for table in tables}
        with Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()
            migration.upgrade()
        for table in tables:
            assert connection.execute(sa.text(f'SELECT * FROM {table} ORDER BY id')).all() == before[table]
        events = connection.execute(sa.text('SELECT * FROM activity ORDER BY created_at')).mappings().all()
        repeated = [event for event in events if event['label'] == 'Repeated']
        assert repeated[0]['interaction_id'] is not None
        assert repeated[1]['interaction_id'] is None
        unique = next(event for event in events if event['label'] == 'Unique question')
        assert unique['interaction_id'] is not None
        assert next(event for event in events if event['kind'] == 'notebook_saved')['notebook_item_id'] is None
