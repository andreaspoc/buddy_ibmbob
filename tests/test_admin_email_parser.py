"""Preserve the existing email acceptance policy without regex backtracking."""
import ast
from pathlib import Path
import random
import re
import unittest


class ValidationError(Exception):
    def __init__(self, status, detail):
        self.status = status
        super().__init__(detail)


class AdminEmailParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path('app/admin_users.py')
        tree = ast.parse(path.read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == 'normalized_email')
        namespace = {'HTTPException': ValidationError}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), namespace)
        cls.normalize = staticmethod(namespace['normalized_email'])

    def test_normalizes_and_retains_existing_domain_policy(self):
        for source, expected in [(' Test@Example.invalid ', 'test@example.invalid'),
                                 ('a@b.c.', 'a@b.c.'), ('a@b..', 'a@b..')]:
            self.assertEqual(self.normalize(source), expected)

    def test_rejects_invalid_or_oversized_addresses(self):
        for source in ('', 'a@b', 'a@@b.c', 'a b@example.invalid', '@example.invalid',
                       'a@.invalid', 'a@example.', 'a@b\nc.invalid', 'a' * 200000 + '@x.invalid'):
            with self.subTest(source=source[:40]), self.assertRaises(ValidationError) as raised:
                self.normalize(source)
            self.assertEqual(raised.exception.status, 422)

    def test_matches_previous_validation_on_synthetic_inputs(self):
        rng = random.Random(417)
        alphabet = 'ab@._+- \t\n\u2003'
        for _ in range(3000):
            source = ''.join(rng.choices(alphabet, k=rng.randrange(25)))
            normalized = source.strip().lower()
            accepted = bool(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', normalized))
            if accepted:
                self.assertEqual(self.normalize(source), normalized)
            else:
                with self.assertRaises(ValidationError):
                    self.normalize(source)
