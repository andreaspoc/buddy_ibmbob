"""Task grants are rejected; durable execution grants are action-bound and single use."""
import ast
import json
from pathlib import Path
import unittest


def load_function(path, name, namespace):
    node = next(n for n in ast.parse(Path(path).read_text()).body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, 'exec'), namespace)
    return namespace[name]


class ApprovalDatabase:
    def __init__(self):
        self.row = {'event': {'actor': 'owner', 'action_digest': 'digest', 'scope': 'action'},
                    'status': 'running', 'decision': None, 'valid': True}
        self.calls = []
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def execute(self, sql, args):
        self.calls.append((sql, args))
        if sql.startswith('SELECT id FROM bob_jobs'):
            self.result = {'id': 'job'} if args == ('job', 'owner', 'token') else None
        elif sql.startswith('SELECT'):
            self.result = self.row
        elif sql.startswith('UPDATE bob_job_approvals SET decision='):
            self.row['decision'] = args[0]
            self.row['event'] = json.loads(args[1])
        elif sql.startswith('UPDATE bob_job_approvals SET event='):
            self.row['event'] = json.loads(args[0])
        return self
    def fetchone(self): return self.result


class TaskApprovalTests(unittest.TestCase):
    def setUp(self):
        self.db = ApprovalDatabase()
        namespace = {'_connect': lambda: self.db, '_dumps_jsonb': json.dumps}
        self.decide = load_function('app/job_queue.py', 'decide_approval', namespace)
        self.consume = load_function('app/job_queue.py', 'consume_execution_approval', namespace)

    def test_task_wide_approval_is_rejected_without_update(self):
        with self.assertRaisesRegex(ValueError, 'task-wide approvals are disabled'):
            self.decide('job', 'owner', 'approval', 'approve_task')
        self.assertIsNone(self.db.row['decision'])
        self.assertFalse(any(sql.startswith('UPDATE') for sql, _ in self.db.calls))

    def test_exact_action_decision_is_immutable_and_consumed_once(self):
        result = self.decide('job', 'owner', 'approval', 'approve')
        self.assertEqual(result['scope'], 'action')
        self.assertEqual(self.decide('job', 'owner', 'approval', 'approve')['status'], 'approved')
        with self.assertRaises(ValueError):
            self.decide('job', 'owner', 'approval', 'reject')
        self.assertEqual(self.consume('job', 'token', 'approval', 'owner', 'digest'), 'approve')
        self.assertTrue(self.db.row['event']['consumed'])
        self.assertTrue(any('INSERT INTO bob_job_events' in sql for sql, _ in self.db.calls))
        with self.assertRaises(PermissionError):
            self.consume('job', 'token', 'approval', 'owner', 'digest')
        with self.assertRaises(ValueError):
            self.decide('job', 'owner', 'approval', 'approve')

    def test_pending_grant_does_not_authorize_execution(self):
        self.assertIsNone(self.consume('job', 'token', 'approval', 'owner', 'digest'))
        self.assertFalse(self.db.row['event'].get('consumed', False))

    def test_changed_actor_parameters_expiry_and_legacy_scope_are_denied(self):
        self.db.row['decision'] = 'approve'
        for actor, digest in (('other-user', 'digest'), ('owner', 'changed-parameters')):
            with self.subTest(actor=actor, digest=digest), self.assertRaises(PermissionError):
                self.consume('job', 'token', 'approval', actor, digest)
        self.db.row['valid'] = False
        with self.assertRaisesRegex(PermissionError, 'expired'):
            self.consume('job', 'token', 'approval', 'owner', 'digest')
        self.db.row['valid'] = True
        self.db.row['event']['scope'] = 'task'
        with self.assertRaises(PermissionError):
            self.consume('job', 'token', 'approval', 'owner', 'digest')


if __name__ == '__main__': unittest.main()
