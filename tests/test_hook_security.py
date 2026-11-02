"""Security regressions using only the standard library (also pytest-discoverable)."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import hooks


class HookSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"HOME": self.temp.name, "DATABASE_URL": ""})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_invalid_ids_rejected_for_every_mutation(self):
        for value in ("../outside", "/tmp/outside", "a/b", "a\\b", "a.sh", "a" * 81, 4):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    hooks.save_hook({"id": value, "script_code": "exit 0"}, self.root)
                with self.assertRaises(ValueError):
                    hooks.delete_hook(value, self.root)
                with self.assertRaises(ValueError):
                    hooks.toggle_hook(value, True, self.root)
        self.assertFalse((self.root / 'outside.sh').exists())

    def test_script_symlink_cannot_be_overwritten_or_deleted(self):
        directory = self.root / '.bob/hooks'
        directory.mkdir(parents=True)
        outside = self.root / 'outside.sh'
        outside.write_text('original')
        (directory / 'test.sh').symlink_to(outside)
        for operation in (
            lambda: hooks.save_hook({'id': 'test', 'script_code': 'changed'}, self.root),
            lambda: hooks.delete_hook('test', self.root),
        ):
            with self.assertRaises(ValueError):
                operation()
        self.assertEqual(outside.read_text(), 'original')

    def test_symlink_directory_rejected(self):
        (self.root / '.bob').mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (self.root / '.bob/hooks').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            hooks.save_hook({'id': 'test', 'script_code': 'changed'}, self.root)
        self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_persisted_id_never_written_or_executed(self):
        with patch.object(hooks, '_connect_db') as connect:
            conn = connect.return_value.__enter__.return_value
            conn.execute.return_value.fetchall.return_value = [
                ('../outside', 'bad', '', 'PreToolUse', '.*', 'touch bad', 'bad', 5000, True, True)
            ]
            hooks.list_hooks(self.root)
        self.assertFalse((self.root / '.bob/outside.sh').exists())

    def test_valid_hook_round_trip_and_private_mode(self):
        item = hooks.save_hook({'id': 'good-hook_1', 'script_code': '#!/bin/sh\nexit 0'}, self.root)
        self.assertEqual(hooks.list_hooks(self.root)[0]['script_code'], item['script_code'])
        self.assertEqual((self.root / '.bob/hooks/good-hook_1.sh').stat().st_mode & 0o777, 0o700)
        self.assertTrue(hooks.toggle_hook(item['id'], False, self.root))
        self.assertTrue(hooks.delete_hook(item['id'], self.root))

    def test_audit_records_metadata_without_script_contents(self):
        with self.assertLogs('security.hooks', level='INFO') as captured:
            hooks.record_hook_audit({'id': 17, 'password': 'do-not-log'}, 'save', 'good-hook')
        self.assertIn('17', captured.output[0])
        self.assertNotIn('do-not-log', captured.output[0])

    def test_blocking_hook_still_enforces_policy(self):
        hooks.save_hook({'id': 'guard', 'event': 'PreToolUse',
                         'script_code': '#!/bin/sh\necho blocked >&2; exit 2'}, self.root)
        allowed, out, err = asyncio.run(hooks.execute_event_hooks(
            'PreToolUse', {}, workspace_root=self.root))
        self.assertFalse(allowed)
        self.assertEqual(out, '')
        self.assertEqual(err, 'blocked')

    def test_enforcement_hook_failure_denies_action(self):
        hooks.save_hook({'id': 'guard', 'event': 'PreToolUse',
                         'script_code': '#!/bin/sh\nexit 1'}, self.root)
        allowed, _, _ = asyncio.run(hooks.execute_event_hooks(
            'PreToolUse', {}, workspace_root=self.root))
        self.assertFalse(allowed)

    def test_invalid_persisted_hook_fails_closed(self):
        with patch.object(hooks, 'list_hooks', return_value=[
            {'id': '../bad', 'event': 'PreToolUse', 'command': 'exit 0'}
        ]), patch.object(hooks, 'run_single_hook') as execute:
            allowed, _, _ = asyncio.run(hooks.execute_event_hooks(
                'PreToolUse', {}, workspace_root=self.root))
        self.assertFalse(allowed)
        execute.assert_not_called()

    def test_service_secrets_not_inherited(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'sensitive', 'OPENAI_API_KEY': 'sensitive'}):
            code, out, err = asyncio.run(hooks.run_single_hook(
                "printf '%s:%s' \"${DATABASE_URL-unset}\" \"${OPENAI_API_KEY-unset}\"", {}, self.root))
        self.assertEqual((code, out, err), (0, 'unset:unset', ''))

    def test_output_is_bounded(self):
        code, out, err = asyncio.run(hooks.run_single_hook('yes output', {}, self.root))
        self.assertEqual(code, -1)
        self.assertEqual(out, '')
        self.assertIn('exceeded', err)

    def test_timeout_kills_descendants(self):
        marker = self.root / 'escaped'
        command = f'(sleep 0.7; touch {marker}) & wait'
        async def check():
            result = await hooks.run_single_hook(command, {}, self.root, 100)
            await asyncio.sleep(0.9)
            return result
        code, _, err = asyncio.run(check())
        self.assertEqual(code, -1)
        self.assertIn('timed out', err)
        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()

class HookAuditStorageTests(unittest.TestCase):
    def test_durable_audit_contains_only_actor_action_and_id(self):
        from unittest.mock import MagicMock
        from contextlib import contextmanager
        conn = MagicMock()
        @contextmanager
        def database():
            yield conn
        with patch.object(hooks, '_connect_db', database):
            hooks.record_hook_audit({'username': 'admin', 'password': 'secret'}, 'save-hook', 'hook-1')
        args = conn.execute.call_args.args
        self.assertIn('bob_access_audit', args[0])
        self.assertEqual(args[1], ('admin', 'save-hook', 'hook-1'))

    def test_database_context_does_not_swallow_caller_errors(self):
        from unittest.mock import MagicMock
        fake = MagicMock()
        connection = fake.connect.return_value.__enter__.return_value
        with patch.object(hooks, 'psycopg', fake), patch.dict(os.environ, {'DATABASE_URL': 'postgresql://synthetic-test-only'}):
            with self.assertRaisesRegex(ValueError, 'caller failure'):
                with hooks._connect_db() as actual:
                    self.assertIs(actual, connection)
                    raise ValueError('caller failure')
        fake.connect.return_value.__exit__.assert_called_once()
