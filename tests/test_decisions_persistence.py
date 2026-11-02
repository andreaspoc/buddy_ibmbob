"""Production PostgreSQL storage functions with synthetic transaction adapters.

No application database, provider or operational data is used by these tests.
"""
import copy
from datetime import datetime, timezone
import importlib
import json
import os
import unittest
from unittest.mock import patch

storage = importlib.import_module('app.decisions_buddy.db')


def model(**changes):
    return {'id': 'synthetic', 'name': 'Synthetic decision', 'description': 'Test fixture',
            'graph': {'nodes': [], 'edges': []}, 'default_input': {}, 'version': 1,
            'status': 'published', 'environment': 'production', 'updated_at': datetime.now(timezone.utc),
            'updated_by': 'owner', 'owner': 'owner', 'approver': 'reviewer', 'access_policy': 'private', **changes}


class Database:
    def __init__(self, record=None):
        self.record = record
        self.history = []
        self.events = []
        self.calls = []
        self.result = None
        self.fail_on = None
        self.closed = False
        self.snapshot = None
    def __enter__(self):
        self.snapshot = copy.deepcopy((self.record, self.history, self.events))
        return self
    def __exit__(self, exc_type, *args):
        if exc_type:
            self.record, self.history, self.events = self.snapshot
    def close(self): self.closed = True
    def execute(self, sql, parameters=()):
        self.calls.append((sql, parameters))
        compact = ' '.join(sql.split())
        if self.fail_on and self.fail_on in compact:
            raise RuntimeError('Synthetic transaction failure')
        if compact.startswith('SELECT * FROM decisions.decisions'):
            self.result = copy.deepcopy(self.record)
        elif compact.startswith('INSERT INTO decisions.decisions '):
            identity, name, description, graph, inputs, actor, owner, policy = parameters
            self.record = model(id=identity, name=name, description=description, graph=json.loads(graph),
                                default_input=json.loads(inputs), updated_by=actor, owner=owner,
                                access_policy=policy, status='draft', environment='development', approver=None)
            self.result = copy.deepcopy(self.record)
        elif compact.startswith('UPDATE decisions.decisions SET name='):
            name, description, graph, inputs, version, actor, status, policy, identity = parameters
            self.record.update(name=name, description=description, graph=json.loads(graph),
                               default_input=json.loads(inputs), version=version, updated_by=actor,
                               status=status, access_policy=policy, approver=None)
            self.result = copy.deepcopy(self.record)
        elif compact.startswith('UPDATE decisions.decisions SET status='):
            status, environment, approver, identity = parameters
            self.record.update(status=status, environment=environment, approver=approver)
            self.result = copy.deepcopy(self.record)
        elif compact.startswith('INSERT INTO decisions.decision_versions'):
            self.history.append(parameters)
        elif compact.startswith('INSERT INTO decisions.events'):
            self.events.append(parameters)
        elif compact.startswith('SELECT * FROM decisions.decision_versions'):
            self.result = {'graph': {'nodes': [{'id': 'historical'}]}, 'default_input': {},
                           'name': 'Historical name', 'description': 'Historical description'}
        return self
    def fetchone(self): return self.result
    def fetchall(self): return self.result or []


class PersistenceTests(unittest.TestCase):
    def test_schema_uses_shared_postgres_namespace_without_seed_records(self):
        db = Database()
        with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://synthetic-test-only'}), \
                patch.object(storage, '_schema_database', None), patch.object(storage, '_connect', return_value=db):
            storage.init_db()
        queries = '\n'.join(query for query, _ in db.calls)
        for name in ('decisions.decisions', 'decisions.decision_versions', 'decisions.audit_logs',
                     'decisions.cp4d_governance', 'decisions.sqlite_imports', 'decisions.events'):
            self.assertIn(name, queries)
        self.assertIn('JSONB', queries)
        self.assertNotIn('INSERT INTO decisions.decisions', queries)
        self.assertNotIn('sqlite', queries.lower().replace('sqlite_imports', 'imports'))

    def test_missing_database_cannot_fall_back_to_source_tree_sqlite(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, 'PostgreSQL'):
            storage.init_db()

    def test_new_record_history_and_event_commit_together(self):
        db = Database()
        with patch.object(storage, 'get_connection', return_value=db):
            result = storage.save_decision('synthetic', 'New model', '', {'nodes': []}, {}, author='owner', expected_version=0)
        self.assertEqual((result['version'], result['status'], result['accessPolicy']), (1, 'draft', 'private'))
        self.assertEqual(len(db.history), 1)
        self.assertEqual(len(db.events), 1)
        self.assertTrue(db.closed)

    def test_governance_validation_runs_under_same_lock_before_mutation(self):
        db = Database(model())
        captured = []
        def validate(connection, record):
            captured.append((connection, record))
            self.assertIn('FOR UPDATE', db.calls[-1][0])
            raise PermissionError('Synthetic governance validation denial')
        with patch.object(storage, 'get_connection', return_value=db), self.assertRaises(PermissionError):
            storage.update_governance_status('synthetic', 'published', author='reviewer',
                approver='reviewer', is_admin=True, expected_version=1, validate=validate)
        self.assertIs(captured[0][0], db)
        self.assertEqual(captured[0][1]['version'], 1)
        self.assertFalse(any(sql.lstrip().startswith('UPDATE') for sql, _ in db.calls))

    def test_owner_and_expected_version_are_checked_under_lock(self):
        for author, version, error in [('other', 1, PermissionError), ('owner', 0, storage.RevisionConflict)]:
            db = Database(model())
            with patch.object(storage, 'get_connection', return_value=db), self.assertRaises(error):
                storage.save_decision('synthetic', 'Changed', '', {}, {}, author=author, expected_version=version)
            self.assertFalse(any(sql.lstrip().startswith('UPDATE') for sql, _ in db.calls))
            self.assertIn('FOR UPDATE', db.calls[1][0])

    def test_admin_edit_keeps_owner_and_invalidates_old_approval_and_sync(self):
        db = Database(model())
        with patch.object(storage, 'get_connection', return_value=db):
            result = storage.save_decision('synthetic', 'Changed', '', {}, {}, author='admin-reviewer', is_admin=True, expected_version=1)
        self.assertEqual((result['version'], result['owner'], result['updatedBy']), (2, 'owner', 'admin-reviewer'))
        self.assertEqual(result['status'], 'in_review')
        self.assertIsNone(result['approver'])
        self.assertTrue(any("sync_status='stale'" in sql for sql, _ in db.calls))

    def test_failed_history_or_audit_rolls_back_the_model(self):
        for fail in ('INSERT INTO decisions.decision_versions', 'INSERT INTO decisions.events'):
            db = Database(model())
            original = copy.deepcopy(db.record)
            db.fail_on = fail
            with patch.object(storage, 'get_connection', return_value=db), self.assertRaises(RuntimeError):
                storage.save_decision('synthetic', 'Must not persist', '', {}, {}, author='owner', expected_version=1)
            self.assertEqual(db.record, original)
            self.assertEqual(db.history, [])
            self.assertEqual(db.events, [])

    def test_rollback_preserves_private_scope_and_creates_a_new_version(self):
        db = Database(model())
        with patch.object(storage, 'get_connection', return_value=db):
            result = storage.rollback_decision('synthetic', 1, author='owner', expected_version=1)
        self.assertEqual(result['version'], 2)
        self.assertEqual(result['accessPolicy'], 'private')
        self.assertEqual(result['graph']['nodes'][0]['id'], 'historical')

    def test_evaluation_credentials_are_redacted_before_audit_persistence(self):
        db = Database()
        with patch.object(storage, 'get_connection', return_value=db):
            storage.log_evaluation('synthetic', {'password': 'synthetic-secret'}, {}, 1.5, 0, [], user_id='owner')
        encoded = db.calls[0][1][1]
        self.assertNotIn('synthetic-secret', encoded)
        self.assertIn('[redacted]', encoded)
        with self.assertRaises(PermissionError):
            storage.log_evaluation('synthetic', {}, {}, 1, 0, [])


if __name__ == '__main__': unittest.main()
