"""One-time move from fixed per-user access flags to ordinary administrator-managed groups."""
from uuid import uuid4

from psycopg.types.json import Jsonb

MIGRATION = 'fixed-access-groups'
_RESTRICTED_LIBRARY = 'india'
_RESTRICTED_GROUP = 'Restricted Team'


def _label(value):
    return value.replace('_', ' ').title()


class _Groups:
    """Create a group only when something refers to it, keeping each member's access unchanged."""

    def __init__(self, db):
        self.db = db
        self.created = {}

    def _group(self, name, membership_sql, params=()):
        if name in self.created:
            return self.created[name]
        row = self.db.execute('SELECT id FROM bob_app_groups WHERE lower(name)=lower(%s)', (name,)).fetchone()
        identity = str(row[0]) if row else str(uuid4())
        if not row:
            self.db.execute("INSERT INTO bob_app_groups(id,name,created_by) VALUES (%s,%s,'migration')", (identity, name))
        self.db.execute('INSERT INTO bob_app_group_members(group_id,username) SELECT %s,username '
                        f'FROM bob_user_profiles WHERE {membership_sql} ON CONFLICT DO NOTHING', (identity, *params))
        self.created[name] = identity
        return identity

    def employer(self, value):
        return self._group(_label(value), 'employer=%s', (value,))

    def restricted(self):
        return self._group(_RESTRICTED_GROUP, 'india_team')

    def restricted_employer(self, value):
        return self._group(f'{_RESTRICTED_GROUP} {_label(value)}', 'india_team AND employer=%s', (value,))

    def audience(self, library, audience):
        """Return the audience that grants exactly the access the old pair granted."""
        if library == _RESTRICTED_LIBRARY:
            return self.restricted() if audience == 'both' else self.restricted_employer(audience)
        return audience if audience == 'both' else self.employer(audience)

    def grant(self, value):
        if value == 'company':
            return value
        if value == 'india_team':
            return self.restricted()
        if value.startswith('india_'):
            return self.restricted_employer(value.removeprefix('india_'))
        return self.employer(value)


def _table_exists(db, name):
    return db.execute('SELECT to_regclass(%s)', (name,)).fetchone()[0] is not None


def _migrate_classified(db, groups, table):
    if not _table_exists(db, table):
        return
    if table == 'bob_mcp_registry':
        db.execute('ALTER TABLE bob_mcp_registry DROP CONSTRAINT IF EXISTS bob_mcp_registry_audience_check')
        db.execute('ALTER TABLE bob_mcp_registry DROP CONSTRAINT IF EXISTS bob_mcp_registry_knowledge_base_check')
    pairs = db.execute(f'SELECT DISTINCT knowledge_base,audience FROM {table}').fetchall()
    for library, audience in pairs:
        target = groups.audience(library, audience)
        db.execute(f"UPDATE {table} SET knowledge_base='company',audience=%s WHERE knowledge_base=%s AND audience=%s",
                   (target, library, audience))


def _migrate_catalog(db, groups):
    if _table_exists(db, 'bob_mcp_catalog'):
        for identity, definition in db.execute('SELECT id,definition FROM bob_mcp_catalog').fetchall():
            updated = dict(definition)
            updated['groups'] = [groups.grant(value) for value in definition.get('groups', [])]
            updated['audience'] = groups.audience(definition.get('knowledge_base', 'company'), definition.get('audience', 'both'))
            updated['knowledge_base'] = 'company'
            db.execute('UPDATE bob_mcp_catalog SET definition=%s WHERE id=%s', (Jsonb(updated), identity))
    if _table_exists(db, 'bob_agent_catalog'):
        for identity, values in db.execute('SELECT id,groups FROM bob_agent_catalog').fetchall():
            db.execute('UPDATE bob_agent_catalog SET groups=%s WHERE id=%s',
                       (Jsonb([groups.grant(value) for value in values]), identity))


def migrate_fixed_groups(db):
    """Runs once. Old columns stay in place, unused, so the change can be inspected or undone."""
    if not db.execute('INSERT INTO bob_auth_migrations VALUES (%s) ON CONFLICT DO NOTHING RETURNING name', (MIGRATION,)).fetchone():
        return
    legacy = db.execute("SELECT 1 FROM information_schema.columns WHERE table_name='bob_user_profiles' AND column_name='employer'").fetchone()
    if not legacy:
        return
    groups = _Groups(db)
    for (value,) in db.execute('SELECT DISTINCT employer FROM bob_user_profiles WHERE employer IS NOT NULL').fetchall():
        groups.employer(value)
    if db.execute('SELECT 1 FROM bob_user_profiles WHERE india_team LIMIT 1').fetchone():
        groups.restricted()
    _migrate_classified(db, groups, 'bob_knowledge_documents')
    _migrate_classified(db, groups, 'bob_mcp_registry')
    _migrate_catalog(db, groups)
