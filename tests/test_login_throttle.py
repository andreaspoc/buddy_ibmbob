"""Authentication attempt budgets and actual route wiring without network/DB dependencies."""
import ast
import asyncio
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch
from app import login_throttle as limiter


class LoginThrottleTests(TestCase):
    def test_normalized_account_and_source_budgets_are_distinct_and_hashed(self):
        keys = limiter.bucket_keys(' Alice ', '192.0.2.1')
        self.assertEqual(keys, limiter.bucket_keys('alice', '192.0.2.1'))
        self.assertNotEqual(keys, limiter.bucket_keys('alice', '192.0.2.2'))
        self.assertTrue(all(len(key.split(':')[1]) == 64 for key, _ in keys))
        self.assertNotIn('alice', repr(keys))

    def run_reservation(self, counts):
        db = MagicMock()
        results = iter(counts)
        def execute(sql, params=None):
            result = MagicMock()
            if 'RETURNING attempts' in sql:
                result.fetchone.return_value = (next(results),)
            return result
        db.execute.side_effect = execute
        commits = []
        @contextmanager
        def database():
            yield db
            commits.append(True)
        with patch.object(limiter, '_database', database):
            try:
                limiter.reserve_login_attempt('alice', '192.0.2.1')
            except limiter.LoginThrottled:
                self.assertEqual(commits, [True], 'blocked attempts still commit their reservation')
                raise
        return db

    def test_account_or_source_exhaustion_blocks(self):
        for counts in ([1, limiter.ACCOUNT_LIMIT + 1], [limiter.SOURCE_LIMIT + 1]):
            with self.subTest(counts=counts), self.assertRaises(limiter.LoginThrottled):
                self.run_reservation(counts)
        db = self.run_reservation([1, 1])
        inserts = [call for call in db.execute.call_args_list if 'RETURNING attempts' in call.args[0]]
        self.assertEqual(len(inserts), 2)
        self.assertTrue(all('interval \'60 seconds\'' in call.args[0] for call in inserts))

    def test_success_clears_only_the_normalized_account_bucket(self):
        db = MagicMock()
        @contextmanager
        def database():
            yield db
        with patch.object(limiter, '_database', database):
            limiter.clear_account_attempts(' Alice ')
        db.execute.assert_called_once_with(
            'DELETE FROM bob_login_attempts WHERE bucket=%s',
            (limiter.bucket_keys('alice', '')[0][0],),
        )

    def test_retry_after_is_bounded_to_the_window(self):
        self.assertEqual(limiter.LoginThrottled(0).retry_after, 1)
        self.assertEqual(limiter.LoginThrottled(15).retry_after, 15)
        self.assertEqual(limiter.LoginThrottled(999).retry_after, limiter.WINDOW_SECONDS)

    def test_actual_login_route_throttles_before_password_check(self):
        source = ast.parse(Path('app/main.py').read_text())
        route = next(node for node in source.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'auth_login')
        route.decorator_list = []; route.args.defaults = []; route.returns = None
        for arg in route.args.args: arg.annotation = None
        class HTTPError(Exception):
            def __init__(self, status_code, detail, headers=None):
                self.status_code = status_code; self.headers = headers
        async def thread(fn, *args): return fn(*args)
        authenticate = MagicMock(return_value={'username': 'alice'})
        reserve = MagicMock(side_effect=limiter.LoginThrottled())
        namespace = {'local_login_enabled': lambda: True, 'run_in_threadpool': thread,
                     'reserve_login_attempt': reserve, 'LoginThrottled': limiter.LoginThrottled,
                     'HTTPException': HTTPError, 'authenticate': authenticate,
                     'clear_account_attempts': MagicMock(), 'start_session': MagicMock()}
        exec(compile(ast.Module(body=[route], type_ignores=[]), 'app/main.py', 'exec'), namespace)
        request = SimpleNamespace(client=SimpleNamespace(host='192.0.2.1'), headers={'x-forwarded-for': 'forged'})
        req = SimpleNamespace(username='alice', password='not-a-real-password')
        with self.assertRaises(HTTPError) as error:
            asyncio.run(namespace['auth_login'](req, request, object()))
        self.assertEqual(error.exception.status_code, 429)
        self.assertIn('Retry-After', error.exception.headers)
        authenticate.assert_not_called()
        reserve.assert_called_once_with('alice', '192.0.2.1')
        reserve.side_effect = None
        asyncio.run(namespace['auth_login'](req, request, object()))
        namespace['clear_account_attempts'].assert_called_once_with('alice')
        namespace['start_session'].assert_called_once()
