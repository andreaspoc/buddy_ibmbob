"""Run every registered Python test once and fail if any test fails or is skipped."""
import ast
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent


def registered_tests():
    tree = ast.parse((ROOT / 'scripts' / 'sonar_python_coverage.py').read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], 'id', '') == 'DEFAULT_TESTS':
            return ast.literal_eval(node.value)
    raise SystemExit('DEFAULT_TESTS was not found')


def main():
    suite = unittest.defaultTestLoader.loadTestsFromNames(registered_tests())
    result = unittest.TextTestRunner(verbosity=0).run(suite)
    for test, reason in result.skipped:
        print(f'SKIPPED {test.id()}: {reason}', file=sys.stderr)
    print(f'{result.testsRun} run, {len(result.failures) + len(result.errors)} failed, {len(result.skipped)} skipped', file=sys.stderr)
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == '__main__':
    sys.exit(main())
