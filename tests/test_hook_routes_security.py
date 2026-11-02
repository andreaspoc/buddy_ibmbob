"""Run actual route/dependency bodies without importing unavailable API dependencies.

These isolated AST tests verify authorization wiring and bodies. They do not
replace a deployed ASGI authentication/integration test.
"""
import ast
import asyncio
import copy
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

ROOT = Path(__file__).resolve().parents[1]
MAIN = ast.parse((ROOT / 'app/main.py').read_text())
ADMIN = ast.parse((ROOT / 'app/admin_users.py').read_text())


class HTTPException(Exception):
    def __init__(self, status_code, detail=None):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def extract_function(tree, name, namespace=None):
    """Compile a copy of the real function body, keeping defaults testable."""
    node = copy.deepcopy(next(
        item for item in tree.body
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == name
    ))
    node.decorator_list = []
    node.returns = None
    for argument in node.args.args + node.args.kwonlyargs:
        argument.annotation = None
    env = {'HTTPException': HTTPException, 'Depends': lambda dependency: dependency,
           'current_user': object(), 'administrator': object()}
    env.update(namespace or {})
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    exec(compile(module, '<actual-app-function>', 'exec'), env)
    return env[name]


def hook_routes():
    routes = []
    for node in MAIN.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not decorator.args:
                continue
            path = decorator.args[0]
            if isinstance(path, ast.Constant) and isinstance(path.value, str):
                if path.value == '/hooks' or path.value.startswith('/hooks/') or path.value == '/api/hooks' or path.value.startswith('/api/hooks/'):
                    routes.append((decorator.func.attr, path.value, node))
    return routes


class HookRouteSecurityTests(unittest.TestCase):
    def test_every_hook_alias_requires_administrator(self):
        routes = hook_routes()
        self.assertEqual(len(routes), 10)
        for method, path, node in routes:
            with self.subTest(method=method, path=path):
                defaults = dict(zip(node.args.args[-len(node.args.defaults):], node.args.defaults))
                user = next(arg for arg in defaults if arg.arg == 'user')
                dependency = defaults[user]
                self.assertIsInstance(dependency, ast.Call)
                self.assertEqual(ast.unparse(dependency), 'Depends(administrator)')

    def test_all_operations_have_both_route_aliases(self):
        expected = {
            ('get', '/hooks'), ('get', '/api/hooks'),
            ('post', '/hooks'), ('post', '/api/hooks'),
            ('delete', '/hooks/{hook_id}'), ('delete', '/api/hooks/{hook_id}'),
            ('post', '/hooks/{hook_id}/toggle'), ('post', '/api/hooks/{hook_id}/toggle'),
            ('post', '/hooks/test'), ('post', '/api/hooks/test'),
        }
        self.assertEqual({(method, path) for method, path, _ in hook_routes()}, expected)

    def test_actual_administrator_dependency_denies_ordinary_account(self):
        administrator = extract_function(ADMIN, 'administrator')
        with self.assertRaises(HTTPException) as denied:
            asyncio.run(administrator({'username': 'employee', 'is_admin': False}))
        self.assertEqual(denied.exception.status_code, 403)
        admin = {'username': 'administrator', 'is_admin': True}
        self.assertEqual(asyncio.run(administrator(admin)), admin)

    def test_disabled_test_route_never_runs_commands_even_for_administrator(self):
        execute = AsyncMock(side_effect=AssertionError('Commands must never execute'))
        shell = Mock(side_effect=AssertionError('Commands must never execute'))
        endpoint = extract_function(MAIN, 'test_hook_execution', {
            'run_single_hook': execute, 'subprocess': shell,
        })
        for is_admin in (False, True):
            with self.subTest(is_admin=is_admin):
                with self.assertRaises(HTTPException) as denied:
                    asyncio.run(endpoint(object(), {'username': 'user', 'is_admin': is_admin}))
                self.assertEqual(denied.exception.status_code, 403)
        execute.assert_not_called()
        shell.assert_not_called()


if __name__ == '__main__':
    unittest.main()
