"""Dependency-free checks for call history writes; integration lives in test_people_calls."""
import ast
from pathlib import Path
import unittest
from unittest.mock import MagicMock

source = ast.parse(Path('plugins/people/buddy_people/community_calls.py').read_text())
functions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in {'record_missed_call', 'end', 'expire'}]
namespace = {'notify': MagicMock()}
exec(compile(ast.Module(body=functions, type_ignores=[]), '<call history>', 'exec'), namespace)


class MissedCallRecordTests(unittest.TestCase):
    def test_unanswered_call_is_persisted_with_unique_call_id(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = None
        row = dict(id='call-id', room_id=12, caller='alice', ended_at='timestamp', accepted_at=None, reason='hangup')
        namespace['record_missed_call'](db, row)
        sql, values = db.execute.call_args.args
        self.assertIn("'Missed voice call'", sql)
        self.assertIn('ON CONFLICT (voice_call_id) DO NOTHING', sql)
        self.assertEqual(values, (12, 'alice', 'timestamp', 'call-id'))

    def test_answered_declined_and_access_removed_calls_are_not_missed(self):
        for accepted, reason in [('timestamp', 'hangup'), (None, 'declined'), (None, 'access_removed')]:
            db = MagicMock()
            namespace['record_missed_call'](db, dict(accepted_at=accepted, reason=reason))
            db.execute.assert_not_called()

    def test_expiry_and_hangup_record_only_returned_transitions(self):
        for function in ['expire', 'end']:
            db = MagicMock()
            db.execute.return_value.fetchone.return_value = None
            db.execute.return_value.fetchall.return_value = []
            if function == 'expire':
                namespace[function](db, 'alice')
            else:
                namespace[function](db, {'id': 'call-id'}, 'hangup')
            self.assertIn('RETURNING *', db.execute.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
