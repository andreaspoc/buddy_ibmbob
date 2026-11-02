"""Isolated real PostgreSQL fixtures for MCP authorization and durable tombstones."""
import uuid
from tests.group_fixtures import make_group
from app import mcp_access
from app.auth import _connect

suffix = uuid.uuid4().hex[:12]
admin, buddy, meridien = ['mcp-' + prefix + suffix for prefix in ['a', 'c', 'm']]
name = 'acl-test-' + suffix
source = 'fixture-' + suffix
try:
    with _connect() as db:
        for username, is_admin in [(admin, True), (buddy, False), (meridien, False)]:
            db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES (%s,%s,%s)', (username, '!fixture-disabled!', is_admin))
            db.execute('INSERT INTO bob_user_profiles(username,display_name) VALUES (%s,%s)', (username, username))
    group = make_group('registry', meridien)
    config = {'httpURL': 'https://fixture.invalid/mcp?api_key=test-secret', 'headers': {'Authorization': 'fixture-secret'}}
    mcp_access.create(admin, name, config, 'company', group)
    assert mcp_access.get_authorized_server(buddy, name) is None
    assert mcp_access.get_authorized_server(admin, name) is None
    assert mcp_access.get_authorized_server(meridien, name) == config
    assert not any(row['name'] == name for row in mcp_access.catalog(admin))
    assert any(row['name'] == name for row in mcp_access.catalog(admin, include_all=True))
    assert mcp_access.admin_config(admin, name)['headers'] == config['headers']
    mcp_access.update(admin, name, {'command': 'python3', 'args': ['fixture']})
    assert mcp_access.admin_config(admin, name)['audience'] == group
    mcp_access.set_access(admin, name, 'company', 'both')
    assert mcp_access.get_authorized_server(buddy, name) is not None
    with _connect() as db:
        events = db.execute('SELECT details FROM bob_access_audit WHERE target=%s', (name,)).fetchall()
    assert 'test-secret' not in str(events) and 'fixture-secret' not in str(events)
    assert mcp_access.delete(admin, name)
    mcp_access.seed(source, {name: config})
    mcp_access.ensure_builtin(name, config)
    assert mcp_access.get_authorized_server(meridien, name) is None
    print('MCP registry scope, admin management, audit redaction and deletion persistence passed.')
finally:
    mcp_access.ensure_schema()
    with _connect() as db:
        db.execute('DELETE FROM bob_mcp_registry WHERE name=%s', (name,))
        db.execute('DELETE FROM bob_mcp_migrations WHERE source=%s', (source,))
        db.execute('DELETE FROM bob_access_audit WHERE actor=%s', (admin,))
        db.execute('DELETE FROM bob_user_profiles WHERE username=ANY(%s)', ([admin, buddy, meridien],))
        db.execute('DELETE FROM users WHERE username=ANY(%s)', ([admin, buddy, meridien],))
