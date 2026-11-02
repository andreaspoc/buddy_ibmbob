"""Real-database proof that moving to groups keeps each person's access exactly the same."""
import os
import unittest
from unittest import skipUnless
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from app.access_migration import MIGRATION, migrate_fixed_groups

DATABASE = os.environ.get('GROUP_MIGRATION_TEST_DATABASE_URL')
EMPLOYERS = ('alpha_corp', 'beta_corp')
OLD_DOCUMENTS = [('company', 'both'), ('company', 'alpha_corp'), ('company', 'beta_corp'),
                 ('india', 'both'), ('india', 'alpha_corp'), ('india', 'beta_corp')]


def old_rule(employer, restricted, library, audience):
    return (library == 'company' or restricted) and (audience == 'both' or audience == employer)


@skipUnless(DATABASE, 'Needs a disposable PostgreSQL database')
class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = psycopg.connect(DATABASE, autocommit=True)
        self.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
        self.db.execute('CREATE TABLE users (username TEXT PRIMARY KEY)')
        self.db.execute('CREATE TABLE bob_auth_migrations (name TEXT PRIMARY KEY)')
        self.db.execute('CREATE TABLE bob_user_profiles (username TEXT PRIMARY KEY, employer TEXT, india_team BOOLEAN NOT NULL DEFAULT FALSE)')
        self.db.execute('CREATE TABLE bob_knowledge_documents (id TEXT PRIMARY KEY, knowledge_base TEXT, audience TEXT)')
        self.db.execute("""CREATE TABLE bob_mcp_registry (name TEXT PRIMARY KEY, knowledge_base TEXT CHECK(knowledge_base IN ('company','india')),
                           audience TEXT CHECK(audience IN ('both','alpha_corp','beta_corp')))""")
        self.db.execute('CREATE TABLE bob_mcp_catalog (id TEXT PRIMARY KEY, definition JSONB)')
        self.db.execute('CREATE TABLE bob_agent_catalog (id TEXT PRIMARY KEY, groups JSONB)')
        from app.app_groups import schema
        schema(self.db)
        self.people = {}
        for employer in (None, *EMPLOYERS):
            for restricted in (False, True):
                name = f'user-{employer or "none"}-{int(restricted)}'.replace('_', '-')
                self.people[name] = (employer, restricted)
                self.db.execute('INSERT INTO users VALUES (%s)', (name,))
                self.db.execute('INSERT INTO bob_user_profiles VALUES (%s,%s,%s)', (name, employer, restricted))
        for index, (library, audience) in enumerate(OLD_DOCUMENTS):
            self.db.execute('INSERT INTO bob_knowledge_documents VALUES (%s,%s,%s)', (f'd{index}', library, audience))
            self.db.execute('INSERT INTO bob_mcp_registry VALUES (%s,%s,%s)', (f'm{index}', library, audience))

    def tearDown(self):
        self.db.close()

    def memberships(self, username):
        return {str(row[0]) for row in self.db.execute('SELECT group_id FROM bob_app_group_members WHERE username=%s', (username,)).fetchall()}

    def test_every_person_keeps_exactly_the_same_access(self):
        migrate_fixed_groups(self.db)
        for table, key in (('bob_knowledge_documents', 'id'), ('bob_mcp_registry', 'name')):
            rows = dict((row[0], row[1:]) for row in self.db.execute(f'SELECT {key},knowledge_base,audience FROM {table}').fetchall())
            for index, (library, audience) in enumerate(OLD_DOCUMENTS):
                new_library, new_audience = rows[f'{"d" if table.endswith("documents") else "m"}{index}']
                self.assertEqual(new_library, 'company')
                for person, (employer, restricted) in self.people.items():
                    now = new_audience == 'both' or new_audience in self.memberships(person)
                    self.assertEqual(now, old_rule(employer, restricted, library, audience), (table, person, library, audience))

    def test_catalog_grants_keep_the_same_people(self):
        everyone, restricted_group = 'company', 'india_team'
        self.db.execute('INSERT INTO bob_mcp_catalog VALUES (%s,%s)', ('c', Jsonb({'groups': [everyone, 'alpha_corp', restricted_group, 'india_beta_corp'], 'audience': 'both', 'knowledge_base': 'company'})))
        self.db.execute('INSERT INTO bob_agent_catalog VALUES (%s,%s)', ('a', Jsonb(['alpha_corp', restricted_group])))
        migrate_fixed_groups(self.db)
        definition = self.db.execute("SELECT definition FROM bob_mcp_catalog WHERE id='c'").fetchone()[0]
        self.assertEqual(definition['groups'][0], everyone)
        names = {row[0]: str(row[1]) for row in self.db.execute('SELECT name,id FROM bob_app_groups').fetchall()}
        self.assertEqual(definition['groups'][1:], [names['Alpha Corp'], names['Restricted Team'], names['Restricted Team Beta Corp']])
        self.assertEqual(self.db.execute("SELECT groups FROM bob_agent_catalog WHERE id='a'").fetchone()[0], [names['Alpha Corp'], names['Restricted Team']])
        self.assertIn(names['Restricted Team Beta Corp'], self.memberships('user-beta-corp-1'))
        self.assertNotIn(names['Restricted Team Beta Corp'], self.memberships('user-beta-corp-0'))
        self.assertNotIn(names['Restricted Team Beta Corp'], self.memberships('user-alpha-corp-1'))

    def test_runs_only_once_and_keeps_later_changes(self):
        migrate_fixed_groups(self.db)
        count = self.db.execute('SELECT count(*) FROM bob_app_groups').fetchone()[0]
        self.db.execute('DELETE FROM bob_app_group_members')
        migrate_fixed_groups(self.db)
        self.assertEqual(self.db.execute('SELECT count(*) FROM bob_app_group_members').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM bob_app_groups').fetchone()[0], count)
        self.assertIsNotNone(self.db.execute('SELECT 1 FROM bob_auth_migrations WHERE name=%s', (MIGRATION,)).fetchone())

    def test_old_columns_are_kept_for_recovery(self):
        migrate_fixed_groups(self.db)
        self.assertEqual(self.db.execute("SELECT employer FROM bob_user_profiles WHERE username='user-alpha-corp-0'").fetchone()[0], 'alpha_corp')

    def test_fresh_install_creates_no_groups(self):
        self.db.execute('ALTER TABLE bob_user_profiles DROP COLUMN employer, DROP COLUMN india_team')
        migrate_fixed_groups(self.db)
        self.assertEqual(self.db.execute('SELECT count(*) FROM bob_app_groups').fetchone()[0], 0)

    def test_new_groups_can_be_assigned_after_migration(self):
        migrate_fixed_groups(self.db)
        group = str(uuid4())
        self.db.execute("INSERT INTO bob_mcp_registry VALUES ('new','company',%s)", (group,))
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM bob_mcp_registry WHERE name='new'").fetchone())
