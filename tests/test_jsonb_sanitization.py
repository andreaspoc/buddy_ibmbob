"""Exercise production JSONB sanitization without importing database drivers."""
import ast
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any
import unittest


def load_sanitizer():
    path = Path('app/job_queue.py')
    tree = ast.parse(path.read_text())
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                 and node.name in {'_clean_null_bytes', '_dumps_jsonb'}]
    namespace = {'json': json, 're': re, 'Any': Any}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(path), 'exec'), namespace)
    return namespace['_dumps_jsonb']


class JsonbSanitizationTests(unittest.TestCase):
    def test_removes_nested_nulls_and_preserves_other_escapes(self):
        dump = load_sanitizer()
        source = {'nul\x00key': ['a\x00b', r'a\u0000b', r'keep\ntext', 'unicode: λ'],
                  'nested': {'value': (r'\path\file', 42, None)}}
        self.assertEqual(json.loads(dump(source)), {
            'nulkey': ['ab', 'ab', r'keep\ntext', 'unicode: λ'],
            'nested': {'value': [r'\path\file', 42, None]}})

    def test_preserves_backslash_runs_without_null_escapes(self):
        dump = load_sanitizer()
        for suffix in ('', 'u0001', 'u000x', 'regular'):
            with self.subTest(suffix=suffix):
                source = '\\' * 1000 + suffix
                self.assertEqual(json.loads(dump(source)), source)

    def test_long_near_miss_finishes_within_subprocess_budget(self):
        program = '''
import json
from tests.test_jsonb_sanitization import load_sanitizer
source = {"synthetic": "\\\\" * 200000 + "u000x"}
assert json.loads(load_sanitizer()(source)) == source
'''
        subprocess.run([sys.executable, '-c', program], check=True, timeout=5)
