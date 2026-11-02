import json
import re
import sqlite3
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from app.task_usage import _CACHE, _stored_usage, read_usage, recover_usage


class UsageRecoveryTests(unittest.TestCase):
    def setUp(self):
        _CACHE.clear()
        self.connection = sqlite3.connect(':memory:')
        self.addCleanup(self.connection.close)
        self.connection.execute('CREATE TABLE tasks(id TEXT, costs TEXT)')
        self.connection.execute('INSERT INTO tasks VALUES (?,?)', ('bobtask', json.dumps({'contextTokens': 42, 'input': 1200, 'output': 34, 'cost': .25})))

    def test_read_reported_usage_and_zero(self):
        self.assertEqual(read_usage(self.connection, ['bobtask', 'missing']), {'bobtask': {'tokens': 1234, 'tokens_basis': 'input_output', 'cost': .25}})
        self.connection.execute('INSERT INTO tasks VALUES (?,?)', ('zero', '{"input":0,"output":0,"cost":0}'))
        self.assertEqual(read_usage(self.connection, ['zero'])['zero'], {'tokens': 0, 'tokens_basis': 'input_output', 'cost': 0})

    def test_task_ids_are_sql_values(self):
        attack = "missing') OR 1=1 --"
        self.assertEqual(read_usage(self.connection, [attack]), {})
        self.assertEqual(self.connection.execute('SELECT count(*) FROM tasks').fetchone()[0], 1)

    def test_lookup_spans_multiple_batches(self):
        ids = [f'task-{index:04}' for index in range(501)]
        self.connection.executemany('INSERT INTO tasks VALUES (?, ?)',
                                    [(task, '{"input":1,"output":2}') for task in ids])
        result = read_usage(self.connection, ids)
        self.assertEqual(len(result), 501)
        self.assertTrue(all(value['tokens'] == 3 for value in result.values()))

    def test_per_call_tokens_match_full_task_cost(self):
        self.connection.execute('CREATE TABLE messages(task_id TEXT, role TEXT, data TEXT)')
        self.connection.execute('INSERT INTO tasks VALUES (?,?)', ('calls', '{"contextTokens":200,"cost":0.6}'))
        for count, cost in [(100, .2), (200, .4)]:
            data = json.dumps({'_meta': {'spend': {'contextTokens': count, 'cost': cost}}})
            self.connection.execute('INSERT INTO messages VALUES (?,?,?)', ('calls', 'assistant', data))
        self.assertEqual(read_usage(self.connection, ['calls'])['calls'],
                         {'tokens': 300, 'tokens_basis': 'context_calls', 'cost': .6})
        self.connection.execute('UPDATE tasks SET costs=? WHERE id=?', ('{"contextTokens":200,"cost":0.8}', 'calls'))
        self.assertEqual(read_usage(self.connection, ['calls'])['calls'], {'cost': .8})

    def test_archived_wal_store_recovers_committed_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bob.db'
            with sqlite3.connect(path) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE tasks(id TEXT, costs TEXT)')
                db.execute('INSERT INTO tasks VALUES (?,?)', ('task', '{"input":100,"output":20,"cost":0.5}'))
                db.commit()
                blobs = {'db': path.read_bytes(), 'db-wal': path.with_name('bob.db-wal').read_bytes()}
                storage = types.SimpleNamespace(get_file=lambda user, scope, key, **kw: {'content': blobs[key]} if key in blobs else None)
                self.assertEqual(_stored_usage(storage, 'owner', 'home:test', 'db', ['task']),
                                 {'task': {'tokens': 120, 'tokens_basis': 'input_output', 'cost': .5}})

    def test_invalid_data_is_not_invented(self):
        for task, costs in [('bad', 'bad JSON'), ('invalid', '{"contextTokens":-1,"cost":"unknown"}')]:
            self.connection.execute('INSERT INTO tasks VALUES (?,?)', (task, costs))
        self.assertEqual(read_usage(self.connection, ['bad', 'invalid']), {'invalid': {}})

    def test_owner_scoped_recovery_preserves_recorded_values(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = types.ModuleType('app.postgres_storage')
            calls = []
            def get_file(username, scope, path, **kwargs):
                if path.endswith('-wal'): return None
                calls.append((username, scope, path))
                return {'content': self.connection.serialize()} if scope == 'home:' + 'a' * 32 else None
            storage.get_file = get_file
            sessions = types.ModuleType('app.sessions')
            sessions._root = lambda: Path(directory)
            sessions._VALID_USER = re.compile(r'^[a-z][a-z0-9-]{0,63}$')
            sessions._VALID_ID = re.compile(r'^(legacy|[a-f0-9]{32})$')
            events = [{'type': 'done', 'session_id': 'bobtask', 'tokens': 42, 'cost': .5},
                      {'type': 'done', 'session_id': 'missing'}]
            with patch.dict('sys.modules', {'app.postgres_storage': storage, 'app.sessions': sessions}), patch('app.postgres_storage', storage, create=True):
                result = recover_usage('owner', 'a' * 32, events)
            self.assertEqual(result[0]['tokens'], 1234)
            self.assertEqual(result[0]['cost'], .5)
            self.assertIsNone(result[1]['tokens'])
            self.assertEqual(events[0]['tokens'], 42)
            self.assertTrue(all(call[0] == 'owner' for call in calls))

    def test_partial_sources_and_poll_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = types.ModuleType('app.postgres_storage')
            sessions = types.ModuleType('app.sessions')
            sessions._root = lambda: Path(directory)
            sessions._VALID_USER = re.compile(r'^[a-z][a-z0-9-]{0,63}$')
            sessions._VALID_ID = re.compile(r'^(legacy|[a-f0-9]{32})$')
            calls = []
            def get_file(username, scope, path, **kwargs):
                if path.endswith('-wal'): return None
                calls.append(scope)
                with sqlite3.connect(':memory:') as db:
                    db.execute('CREATE TABLE tasks(id TEXT, costs TEXT)')
                    costs = {'input': 1200, 'output': 34} if scope.startswith('home:') else {'input': 900, 'output': 99, 'cost': .25}
                    db.execute('INSERT INTO tasks VALUES (?,?)', ('bobtask', json.dumps(costs)))
                    return {'content': db.serialize()}
            storage.get_file = get_file
            with patch.dict('sys.modules', {'app.postgres_storage': storage, 'app.sessions': sessions}), patch('app.postgres_storage', storage, create=True):
                for _ in range(2):
                    result = recover_usage('owner', 'a' * 32, [{'session_id': 'bobtask'}])
                    self.assertEqual(result, [{'session_id': 'bobtask', 'tokens': 1234, 'tokens_basis': 'input_output', 'cost': .25}])
            self.assertEqual(len(calls), 2)

    def test_unavailable_storage_uses_partial_legacy_data(self):
        with tempfile.TemporaryDirectory() as directory:
            legacy = Path(directory) / 'users/owner/.home/.bob/db/bob.db'
            legacy.parent.mkdir(parents=True)
            with sqlite3.connect(legacy) as db:
                db.execute('CREATE TABLE tasks(id TEXT, costs TEXT)')
                db.execute('INSERT INTO tasks VALUES (?,?)', ('bobtask', '{"cost":0.75}'))
            storage = types.ModuleType('app.postgres_storage')
            def unavailable(*args, **kwargs):
                raise RuntimeError('Storage unavailable')
            storage.get_file = unavailable
            sessions = types.ModuleType('app.sessions')
            sessions._root = lambda: Path(directory)
            sessions._VALID_USER = re.compile(r'^[a-z][a-z0-9-]{0,63}$')
            sessions._VALID_ID = re.compile(r'^(legacy|[a-f0-9]{32})$')
            with patch.dict('sys.modules', {'app.postgres_storage': storage, 'app.sessions': sessions}), patch('app.postgres_storage', storage, create=True):
                result = recover_usage('owner', 'a' * 32, [{'session_id': 'bobtask', 'tokens': 1234}])
            self.assertEqual(result, [{'session_id': 'bobtask', 'tokens': None, 'cost': .75}])


if __name__ == '__main__':
    unittest.main()
