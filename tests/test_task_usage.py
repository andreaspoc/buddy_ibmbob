"""Task summaries preserve reported usage, including zero and unknown cost."""
import ast
from datetime import datetime, timezone
from pathlib import Path
import unittest


class TaskUsageTests(unittest.TestCase):
    def test_summary_usage(self):
        # Exercise the serializer without requiring the API/database dependencies.
        tree = ast.parse(Path('app/tasks.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'summary')
        namespace = {'guidance_supported': lambda payload: True}
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'app/tasks.py', 'exec'), namespace)
        row = {'id': 'test', 'workspace_id': 'test', 'status': 'completed',
               'created_at': datetime.now(timezone.utc), 'updated_at': datetime.now(timezone.utc)}
        for terminal, expected in (({'cost': 0.058096, 'tokens': 14745}, 0.058096),
                                   ({'cost': 0}, 0), ({}, None)):
            with self.subTest(terminal=terminal):
                result = namespace['summary']({**row, 'terminal': terminal})
                self.assertEqual(result['cost'], expected)
                self.assertEqual(result['tokens'], terminal.get('tokens'))
