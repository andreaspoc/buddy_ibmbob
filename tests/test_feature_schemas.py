"""Migration checks use synthetic catalogs only; no database is contacted."""
import unittest
from contextlib import contextmanager

from app.feature_schemas import FEATURE_TABLES, MigrationConflict, migrate


class Catalog:
    def __init__(self, relations=(), unexpected=False, fail_move=False):
        self.relations = relations
        self.unexpected = unexpected
        self.fail_move = fail_move
        self.commands = []
        self.committed = False
        self.rolled_back = False

    @contextmanager
    def transaction(self):
        try:
            yield
        except Exception:
            self.rolled_back = True
            raise
        else:
            self.committed = True

    def execute(self, query, params=None):
        self.commands.append((query, params))
        if 'SELECT n.nspname' in query:
            self.rows = list(self.relations)
        elif 'AND NOT (c.relname' in query:
            self.rows = [('unexpected_fixture',)] if self.unexpected else []
        else:
            self.rows = []
        if query.startswith('ALTER TABLE') and self.fail_move:
            raise RuntimeError('injected lock failure')
        return self

    def fetchall(self):
        return self.rows


class FeatureSchemaTest(unittest.TestCase):
    def test_explicit_table_inventory_excludes_core_submission(self):
        self.assertEqual(len(FEATURE_TABLES['office']), 5)
        self.assertEqual(len(FEATURE_TABLES['people_chat']), 13)
        self.assertNotIn('bob_chat_submissions', sum(FEATURE_TABLES.values(), ()))

    def test_check_never_changes_schema_or_tables(self):
        db = Catalog([('public', 'bob_office_files')])
        result = migrate(db)
        self.assertFalse(result['applied'])
        self.assertEqual(result['tables']['office']['move'], 1)
        self.assertFalse(any(q.startswith(('CREATE', 'ALTER')) for q, _ in db.commands))

    def test_apply_moves_only_explicit_feature_tables(self):
        db = Catalog([('public', 'bob_office_files'), ('public', 'bob_chat_rooms'),
                      ('public', 'bob_chat_submissions'), ('public', 'unrelated_fixture')])
        migrate(db, apply=True)
        moves = [q for q, _ in db.commands if q.startswith('ALTER TABLE')]
        self.assertEqual(moves, [
            'ALTER TABLE "public"."bob_office_files" SET SCHEMA "office"',
            'ALTER TABLE "public"."bob_chat_rooms" SET SCHEMA "people_chat"'])
        self.assertTrue(db.committed)

    def test_already_moved_tables_are_idempotent(self):
        db = Catalog([('office', 'bob_office_files')])
        self.assertEqual(migrate(db, apply=True)['tables']['office']['move'], 0)
        self.assertFalse(any(q.startswith('ALTER TABLE') for q, _ in db.commands))

    def test_rollback_returns_only_present_feature_tables_to_public(self):
        db = Catalog([('office', 'bob_office_files')])
        result = migrate(db, apply=True, rollback=True)
        self.assertEqual(result['tables']['office']['move'], 1)
        self.assertIn(('ALTER TABLE "office"."bob_office_files" SET SCHEMA "public"', None), db.commands)

    def test_duplicate_refuses_entire_plan_before_any_ddl(self):
        db = Catalog([('public', 'bob_office_files'), ('office', 'bob_office_files')])
        with self.assertRaises(MigrationConflict):
            migrate(db, apply=True)
        self.assertTrue(db.rolled_back)
        self.assertFalse(any(q.startswith(('CREATE', 'ALTER')) for q, _ in db.commands))

    def test_unexpected_feature_relation_refuses_migration(self):
        with self.assertRaises(MigrationConflict):
            migrate(Catalog(unexpected=True), apply=True)

    def test_move_failure_rolls_back_transaction(self):
        db = Catalog([('public', 'bob_chat_rooms')], fail_move=True)
        with self.assertRaises(RuntimeError):
            migrate(db, apply=True)
        self.assertTrue(db.rolled_back)
        self.assertFalse(db.committed)

    def test_lock_timeout_is_bounded_and_transaction_local(self):
        db = Catalog()
        migrate(db, lock_timeout_ms=1234)
        self.assertIn(("SELECT set_config('lock_timeout', %s, true)", ('1234ms',)), db.commands)
        for value in (0, 60001, '5000'):
            with self.assertRaises(ValueError):
                migrate(Catalog(), lock_timeout_ms=value)


if __name__ == '__main__':
    unittest.main()
