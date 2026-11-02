"""Administrator-owned MCP definitions and live employee audience authorization."""
from threading import Lock
import os

_schema_lock = Lock()
_schema_database = None

from urllib.parse import urlsplit, urlunsplit
from psycopg.types.json import Jsonb
from app.auth import _connect, knowledge_access, valid_audience


def ensure_schema():
    global _schema_database
    database = os.getenv('DATABASE_URL')
    if _schema_database == database and database is not None:
        return
    with _schema_lock:
        if _schema_database == database and database is not None:
            return
        with _connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS bob_mcp_registry (
              name TEXT PRIMARY KEY, config JSONB NOT NULL,
              knowledge_base TEXT NOT NULL DEFAULT 'company',
              audience TEXT NOT NULL DEFAULT 'both',
              deleted BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
            db.execute("CREATE TABLE IF NOT EXISTS bob_mcp_migrations (source TEXT PRIMARY KEY)")
        _schema_database = database


def seed(source, configs, deleted=()):
    """Import each legacy source once; tombstones prevent resurrection."""
    ensure_schema()
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('mcp-registry'))")
        if not db.execute('INSERT INTO bob_mcp_migrations(source) VALUES (%s) ON CONFLICT DO NOTHING RETURNING source', (source,)).fetchone():
            return
        for name, config in configs.items():
            if isinstance(config, dict):
                db.execute('INSERT INTO bob_mcp_registry(name,config,deleted) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING', (name, Jsonb(config), name in deleted))


def _rows():
    ensure_schema()
    with _connect() as db:
        return db.execute('SELECT name,config,knowledge_base,audience FROM bob_mcp_registry WHERE NOT deleted ORDER BY name').fetchall()


def permitted(profile, knowledge_base, audience):
    return bool(profile is not None and (profile.get('is_admin') or (knowledge_base == 'company' and (audience == 'both' or audience in (profile.get('groups') or [])))))


def allowed_servers(username):
    profile = knowledge_access(username)
    shared = {name: config for name, config, base, audience in _rows() if permitted(profile, base, audience)}
    from app.mcp_catalog import allowed_connections, native_policy_active
    if native_policy_active():
        # Explicit catalog grants replace the legacy Microsoft audience once configured.
        shared.pop('microsoft365', None)
    # Catalog credentials belong to this caller and never replace shared names.
    return {**shared, **allowed_connections(username, profile)}


def get_authorized_server(username, name):
    return allowed_servers(username).get(name)


def summary(row, profile):
    name, config, base, audience = row
    transport = 'http' if 'httpURL' in config else 'sse' if 'url' in config else 'stdio'
    target = config.get('httpURL') or config.get('url') or config.get('command', '')
    if transport != 'stdio':
        try:
            parts = urlsplit(target)
            target = urlunsplit(parts._replace(netloc=parts.netloc.rsplit('@', 1)[-1], query='', fragment=''))
        except ValueError:
            target = ''
    return dict(name=name, transport=transport, target=target, disabled=bool(config.get('disabled')), managed=name == 'brave_search', knowledge_base=base, audience=audience, allowed=permitted(profile, base, audience), can_manage=bool(profile and profile.get('is_admin')))


# Existing platform connections already provide these catalog integrations.
SHARED_PROVIDERS = {'domost-mcp': 'docmost', 'docmost': 'docmost', 'docmost-mcp': 'docmost',
                    'brave_search': 'brave-search', 'monday-platform-local': 'monday'}


def configured_providers(username):
    profile = knowledge_access(username)
    return {SHARED_PROVIDERS[name] for name, config, base, audience in _rows()
            if name in SHARED_PROVIDERS and not config.get('disabled') and permitted(profile, base, audience)}


def catalog(username, include_all=False):
    profile = knowledge_access(username)
    return [summary(row, profile) for row in _rows() if permitted(profile, row[2], row[3]) or (include_all and profile and profile.get('is_admin'))]


def preview(profile):
    employee = {**profile, 'is_admin': False}
    return [summary(row, employee) for row in _rows() if permitted(employee, row[2], row[3])]


def _administrator(username):
    if not (knowledge_access(username) or {}).get('is_admin'):
        raise PermissionError('Administrator access required')


def _audit(db, actor, action, name, before=None, after=None):
    db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (actor, action, name, Jsonb({'before': before, 'after': after})))


def create(actor, name, config, knowledge_base="company", audience="both"):
    _administrator(actor)
    if knowledge_base != "company" or not valid_audience(audience):
        raise ValueError("Invalid MCP audience")
    ensure_schema()
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('mcp-registry'))")
        existing = db.execute('SELECT deleted FROM bob_mcp_registry WHERE name=%s', (name,)).fetchone()
        if existing and not existing[0]:
            raise FileExistsError(f"MCP server '{name}' already exists")
        db.execute("INSERT INTO bob_mcp_registry(name,config,knowledge_base,audience) VALUES (%s,%s,%s,%s) ON CONFLICT(name) DO UPDATE SET config=excluded.config,deleted=false,knowledge_base=excluded.knowledge_base,audience=excluded.audience,updated_at=now()", (name, Jsonb(config), knowledge_base, audience))
        after = summary((name, config, knowledge_base, audience), {'is_admin': True})
        _audit(db, actor, 'create-mcp', name, after=after)
    return after


def update(actor, name, config, knowledge_base=None, audience=None):
    _administrator(actor)
    ensure_schema()
    with _connect() as db:
        row = db.execute('SELECT name,config,knowledge_base,audience FROM bob_mcp_registry WHERE name=%s AND NOT deleted FOR UPDATE', (name,)).fetchone()
        if not row:
            raise KeyError(name)
        knowledge_base = knowledge_base or row[2]
        audience = audience or row[3]
        if knowledge_base != 'company' or not valid_audience(audience):
            raise ValueError('Invalid MCP audience')
        before = summary(row, {'is_admin': True})
        fields = {'httpURL','url','command','args','headers','env'}
        merged = {**{k:v for k,v in row[1].items() if k not in fields}, **config}
        db.execute('UPDATE bob_mcp_registry SET config=%s,knowledge_base=%s,audience=%s,updated_at=now() WHERE name=%s', (Jsonb(merged), knowledge_base, audience, name))
        after = summary((name, merged, knowledge_base, audience), {'is_admin': True})
        _audit(db, actor, 'update-mcp', name, before, after)
    return after


def delete(actor, name):
    _administrator(actor)
    if name == 'brave_search':
        raise ValueError('Brave Search is a managed built-in connection and must remain available')
    ensure_schema()
    with _connect() as db:
        row = db.execute('SELECT name,config,knowledge_base,audience FROM bob_mcp_registry WHERE name=%s AND NOT deleted FOR UPDATE', (name,)).fetchone()
        if not row:
            return False
        db.execute('UPDATE bob_mcp_registry SET deleted=true,updated_at=now() WHERE name=%s', (name,))
        _audit(db, actor, 'delete-mcp', name, summary(row, {'is_admin': True}))
    return True


def set_access(actor, name, knowledge_base, audience):
    _administrator(actor)
    if knowledge_base != 'company' or not valid_audience(audience):
        raise ValueError('Invalid MCP audience')
    ensure_schema()
    with _connect() as db:
        row = db.execute('SELECT name,config,knowledge_base,audience FROM bob_mcp_registry WHERE name=%s AND NOT deleted FOR UPDATE', (name,)).fetchone()
        if not row:
            raise KeyError(name)
        before = summary(row, {'is_admin': True})
        db.execute('UPDATE bob_mcp_registry SET knowledge_base=%s,audience=%s,updated_at=now() WHERE name=%s', (knowledge_base, audience, name))
        after = summary((name, row[1], knowledge_base, audience), {'is_admin': True})
        _audit(db, actor, 'classify-mcp', name, before, after)
    return after


def ensure_builtin(name, config):
    """Insert defaults without resetting access or resurrecting removed servers."""
    ensure_schema()
    with _connect() as db:
        db.execute('INSERT INTO bob_mcp_registry(name,config) VALUES (%s,%s) ON CONFLICT DO NOTHING', (name, Jsonb(config)))


def get_managed_server(actor, name):
    _administrator(actor)
    for row in _rows():
        if row[0] == name:
            return {'config': row[1], 'knowledge_base': row[2], 'audience': row[3]}
    return None


def admin_config(actor, name):
    item = get_managed_server(actor, name)
    return {**item['config'], 'knowledge_base': item['knowledge_base'], 'audience': item['audience']} if item else None
