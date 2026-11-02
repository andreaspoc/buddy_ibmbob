"""Live PostgreSQL verification using explicitly synthetic, cleaned-up fixtures.

Run inside the application container. Agent discovery serves a real local HTTP
Agent Card fixture; it does not claim to connect an operational external agent.
"""
import asyncio
import json
import os
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from fastapi import HTTPException
from tests.group_fixtures import make_group
from app.auth import _connect
from app import agent_catalog as a2a, mcp_catalog as mcp, sessions, postgres_storage as storage, productivity
from app.project_memory import MemoryUpdate, read_memory, save_memory, context_for_session
from app.conversation_branching import branch_conversation

suffix = secrets.token_hex(5)
admin, alice, bob = ['catalogtest-' + kind + '-' + suffix for kind in ('admin', 'alice', 'bob')]
accounts = [admin, alice, bob]
agent_id = 'test-agent-' + suffix
mcp_id = 'test-mcp-' + suffix
project_id = uuid.uuid4().hex

class CardHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'name': 'Synthetic fixture agent', 'description': 'Integration fixture only',
                           'url': f'http://127.0.0.1:{self.server.server_port}/a2a', 'protocolVersion': '0.3',
                           'capabilities': {'streaming': True}, 'skills': [{'id': 'fixture', 'name': 'Fixture skill', 'description': 'Synthetic capability'}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args):
        pass

def rejected(status, function, *args):
    try:
        function(*args)
    except HTTPException as error:
        assert error.status_code == status, (error.status_code, status)
    else:
        raise AssertionError('Expected denial')

server = ThreadingHTTPServer(('127.0.0.1', 0), CardHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    print('Configured file storage backend:', os.getenv('BOB_FILE_STORAGE', '(unset)'))
    a2a.ensure_schema(); mcp.ensure_schema(); storage.ensure_schema(); productivity.ensure_schema()
    with _connect() as db:
        for username in accounts:
            db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES(%s,%s,%s)', (username, 'fixture-unused-password-hash', username == admin))
            db.execute('INSERT INTO bob_user_profiles(username,display_name) VALUES(%s,%s)', (username, 'Synthetic ' + username))
    GROUP = make_group('catalog', *(name for name in accounts if name != bob))
    actor = {'username': admin, 'is_admin': True}
    user_a = {'username': alice, 'is_admin': False}
    user_b = {'username': bob, 'is_admin': False}

    template = a2a.Template(id=agent_id, card_url=f'http://127.0.0.1:{server.server_port}/card', groups=[GROUP])
    definition = asyncio.run(a2a.save_template(agent_id, template, actor))
    assert definition['skills'][0]['id'] == 'fixture' and definition['capabilities']['streaming']
    assert any(entry['id'] == agent_id for entry in a2a.catalog(alice))
    assert not any(entry['id'] == agent_id for entry in a2a.catalog(bob))
    a2a.activate(agent_id, a2a.Activation(api_key='synthetic-alice-secret'), user_a)
    rejected(403, a2a.activate, agent_id, a2a.Activation(), user_b)
    runtime = a2a.get_authorized_agent(alice, 'catalog-' + agent_id)
    assert runtime['api_key'] == 'synthetic-alice-secret'
    assert 'synthetic-alice-secret' not in json.dumps(a2a.catalog(alice))
    assert a2a.get_authorized_agent(bob, 'catalog-' + agent_id) is None
    a2a.activate(agent_id, a2a.Activation(api_key=''), user_a)
    assert a2a.get_authorized_agent(alice, 'catalog-' + agent_id)['api_key'] == 'synthetic-alice-secret'
    a2a.update_access(agent_id, a2a.AccessUpdate(users=[bob]), actor)
    assert a2a.get_authorized_agent(alice, 'catalog-' + agent_id) is None
    a2a.activate(agent_id, a2a.Activation(api_key='synthetic-bob-secret'), user_b)
    assert a2a.get_authorized_agent(bob, 'catalog-' + agent_id)['api_key'] == 'synthetic-bob-secret'
    template = template.model_copy(update={'groups': [], 'users': [bob], 'card_url': f'http://127.0.0.1:{server.server_port}/changed-card'})
    asyncio.run(a2a.save_template(agent_id, template, actor))
    assert a2a.get_authorized_agent(bob, 'catalog-' + agent_id) is None
    print('PASS A2A discovery, group/selected-user grants, credential isolation, blank preservation, revocation, target invalidation')

    mt = mcp.Template(id=mcp_id, name='Synthetic MCP fixture', url='https://fixture.invalid/mcp', groups=[GROUP],
                      fields=[mcp.CredentialField(key='token', label='Fixture token', target='Authorization', prefix='Bearer ')])
    mcp.save_template(mt, admin)
    mcp.connect(alice, mcp_id, {'token': 'synthetic-mcp-alice'})
    rejected(404, mcp.connect, bob, mcp_id, {'token': 'synthetic-mcp-bob'})
    assert mcp.allowed_connections(alice)['catalog-' + mcp_id]['headers']['Authorization'] == 'Bearer synthetic-mcp-alice'
    # Existing pre-OAuth definitions omitted the new default auth fields.
    with _connect() as db:
        db.execute("UPDATE bob_mcp_catalog SET definition=definition-'auth_mode'-'oauth_client_id'-'oauth_scopes'-'oauth_client_secret_env'-'oauth_token_auth_method' WHERE id=%s", (mcp_id,))
    mt = mt.model_copy(update={'description': 'Synthetic metadata-only edit'})
    mcp.save_template(mt, admin)
    assert mcp.allowed_connections(alice)['catalog-' + mcp_id]['headers']['Authorization'] == 'Bearer synthetic-mcp-alice'
    assert 'synthetic-mcp-alice' not in json.dumps(mcp.catalog(alice))
    mcp.connect(alice, mcp_id, {'token': ''})
    assert mcp.allowed_connections(alice)['catalog-' + mcp_id]['headers']['Authorization'] == 'Bearer synthetic-mcp-alice'
    mt = mt.model_copy(update={'access_mode': 'users', 'users': [bob]})
    mcp.save_template(mt, admin)
    assert 'catalog-' + mcp_id not in mcp.allowed_connections(alice)
    mcp.connect(bob, mcp_id, {'token': 'synthetic-mcp-bob'})
    mt = mt.model_copy(update={'url': 'https://changed-fixture.invalid/mcp'})
    mcp.save_template(mt, admin)
    assert 'catalog-' + mcp_id not in mcp.allowed_connections(bob)
    print('PASS MCP independent grants, credential isolation, blank preservation, revocation, endpoint invalidation')

    from app.projects import database
    with database() as db:
        db.execute('INSERT INTO projects(id,username,name,source) VALUES(%s,%s,%s,%s)', (project_id, alice, 'Synthetic test project', 'empty'))
    assert read_memory(alice, project_id) == {'brief': '', 'revision': 0}
    memory = save_memory(alice, project_id, MemoryUpdate(brief='Synthetic project decisions', revision=0))
    assert memory['revision'] == 1
    rejected(409, save_memory, alice, project_id, MemoryUpdate(brief='stale edit', revision=0))
    rejected(404, read_memory, bob, project_id)
    project_session = sessions.create_session(alice, project_id)
    assert 'Synthetic project decisions' in context_for_session(alice, project_session['id'])
    personal = sessions.create_session(alice)
    assert context_for_session(alice, personal['id']) == ''
    for event in [{'type': 'request', 'prompt': 'Synthetic first request'}, {'type': 'delta', 'text': 'Synthetic answer'},
                  {'type': 'done', 'session_id': 'synthetic-native-id', 'agent_context_id': 'synthetic-agent-context'},
                  {'type': 'request', 'prompt': 'Synthetic second request'}, {'type': 'delta', 'text': 'later'}, {'type': 'done'}]:
        sessions.append_history(personal['id'], alice, event)
    storage.put_file(alice, 'session:' + personal['id'], 'fixture.csv', b'name,value\nsynthetic,1\n', session_id=personal['id'])
    # Metadata-only Office Suite fixture: never write, read, or delete a real remote object.
    with _connect() as db:
        db.execute('''INSERT INTO bob_storage_files(username,scope,path,content,sha256,mode,modified,object_key,object_bucket,size)
            VALUES(%s,%s,'office_suite-fixture.pdf',NULL,%s,384,0,%s,'synthetic-fixture-bucket',5)''',
            (alice, 'session:' + personal['id'], '0' * 64, 'synthetic-fixture-' + suffix))
    fork = branch_conversation(alice, personal['id'], 0)
    history = sessions.read_history(fork['id'], alice)
    assert sum(event.get('type') == 'request' for event in history) == 1
    assert 'synthetic-native-id' not in json.dumps(history) and 'synthetic-agent-context' not in json.dumps(history)
    assert storage.get_file(alice, 'session:' + fork['id'], 'fixture.csv')['content'] == b'name,value\nsynthetic,1\n'
    with _connect() as db:
        branch_blob = db.execute('SELECT object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s',
                                (alice, 'session:' + fork['id'], 'office_suite-fixture.pdf')).fetchone()
        assert branch_blob == ('synthetic-fixture-' + suffix, 'synthetic-fixture-bucket', 5)
        db.execute('DELETE FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s', (alice, 'session:' + personal['id'], 'office_suite-fixture.pdf'))
        assert db.execute('SELECT 1 FROM bob_storage_files WHERE object_bucket=%s AND object_key=%s',
                          ('synthetic-fixture-bucket', 'synthetic-fixture-' + suffix)).fetchone()
        assert db.execute('SELECT 1 FROM bob_blob_gc WHERE bucket=%s AND object_key=%s',
                          ('synthetic-fixture-bucket', 'synthetic-fixture-' + suffix)).fetchone()
    rejected(404, branch_conversation, bob, personal['id'], 0)
    sessions.append_history(project_session['id'], alice, {'type': 'request', 'prompt': 'project fixture'})
    sessions.append_history(project_session['id'], alice, {'type': 'done'})
    project_fork = branch_conversation(alice, project_session['id'], 0)
    assert project_fork['project_id'] == project_id
    assert sessions.storage_scope(project_fork['id'], alice) == 'project:' + project_id
    print('PASS project memory revision/ownership/context and actual personal/project conversation forks with stored attachment')
    print('PASS Office Suite metadata fork preserves shared object reference after original removal; GC reference remains discoverable')

    recipe = productivity.save_recipe(productivity.Recipe(name='Synthetic recipe', instructions='Fixture instructions'), user_a)
    assert any(str(row['id']) == recipe['id'] for row in productivity.recipes(user_a))
    assert not any(str(row['id']) == recipe['id'] for row in productivity.recipes(user_b))
    rejected(404, productivity.delete_recipe, uuid.UUID(recipe['id']), user_b)
    productivity.delete_recipe(uuid.UUID(recipe['id']), user_a)
    print('PASS reusable recipes owner isolation')
finally:
    server.shutdown(); server.server_close()
    with _connect() as db:
        for table, column in [('bob_agent_catalog', 'id'), ('bob_mcp_catalog', 'id')]:
            if db.execute('SELECT to_regclass(%s)', (table,)).fetchone()[0]:
                db.execute(f'DELETE FROM {table} WHERE {column}=%s', (agent_id if table == 'bob_agent_catalog' else mcp_id,))
        for table in ('bob_deliverable_recipes', 'bob_conversation_history', 'bob_conversations', 'bob_storage_files', 'bob_storage_users'):
            db.execute(f'DELETE FROM {table} WHERE username=ANY(%s)', (accounts,))
        db.execute('DELETE FROM projects WHERE id=%s', (project_id,))
        db.execute('DELETE FROM bob_access_audit WHERE actor=ANY(%s)', (accounts,))
        db.execute('DELETE FROM bob_user_profiles WHERE username=ANY(%s)', (accounts,))
        db.execute('DELETE FROM users WHERE username=ANY(%s)', (accounts,))
        db.execute('DELETE FROM bob_blob_gc WHERE bucket=%s AND object_key=%s', ('synthetic-fixture-bucket', 'synthetic-fixture-' + suffix))
    print('Synthetic fixtures cleaned up')
