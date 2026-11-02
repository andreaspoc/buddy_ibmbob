"""Completion waits are bounded even when the optional usage store is locked."""
import ast
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch


class CompletionUsageTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(Path('app/acp_bridge.py').read_text())
        method = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_get_task_usage')
        namespace = {'Path': Path, 'Any': object}
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'app/acp_bridge.py', 'exec'), namespace)
        self.usage = namespace['_get_task_usage']

    def test_locked_store_does_not_block_for_default_sqlite_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tasks.db'
            with sqlite3.connect(path) as setup:
                setup.execute('CREATE TABLE tasks (id TEXT)')
            with sqlite3.connect(path) as writer:
                writer.execute('BEGIN EXCLUSIVE')
                started = time.monotonic()
                result = self.usage(path, 'fixture')
                elapsed = time.monotonic() - started
                writer.rollback()
            self.assertEqual(result, {})
            self.assertLess(elapsed, 1.5)

    def test_optional_usage_retries_do_not_sleep_after_final_attempt(self):
        with tempfile.NamedTemporaryFile() as file, patch('sqlite3.connect', side_effect=sqlite3.OperationalError('fixture lock')) as connect, patch('time.sleep') as sleep:
            self.assertEqual(self.usage(Path(file.name), 'fixture'), {})
        self.assertEqual(connect.call_count, 4)
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(connect.call_args.kwargs['timeout'], 0.1)
