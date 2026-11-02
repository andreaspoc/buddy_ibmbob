"""Unit tests for app.acp_bridge process management, environment isolation, and SQLite helpers."""
import asyncio
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from app import acp_bridge


class ACPBridgeUnitTests(unittest.IsolatedAsyncioTestCase):
    def test_visible_detail_redaction(self):
        with patch.dict(os.environ, {'BOB_API_KEY': 'secret-bob-key-123'}):
            raw = {'message': 'Authorized with secret-bob-key-123 successfully'}
            redacted = acp_bridge._visible_detail(raw)
            self.assertNotIn('secret-bob-key-123', str(redacted))
            self.assertIn('[redacted]', str(redacted))

    def test_task_exists_and_usage(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / 'bob.db'
            # non-existent
            self.assertFalse(acp_bridge._task_exists(db_path, 'task-1'))
            self.assertEqual(acp_bridge._get_task_usage(db_path, 'task-1'), {})

            # create sqlite table
            with sqlite3.connect(db_path) as conn:
                conn.execute('CREATE TABLE tasks (id TEXT PRIMARY KEY)')
                conn.execute('INSERT INTO tasks VALUES (?)', ('task-1',))

            self.assertTrue(acp_bridge._task_exists(db_path, 'task-1'))
            self.assertFalse(acp_bridge._task_exists(db_path, 'task-missing'))

            with patch('app.task_usage.read_usage', return_value={'task-1': {'tokens': 450, 'cost': 0.05}}):
                usage = acp_bridge._get_task_usage(db_path, 'task-1')
                self.assertEqual(usage.get('tokens'), 450)
                self.assertEqual(usage.get('cost'), 0.05)

    async def test_terminate_process_group(self):
        mock_proc = MagicMock()
        mock_proc.pid = 99999
        mock_proc.wait = AsyncMock(return_value=0)

        with patch('os.killpg') as mock_killpg:
            await acp_bridge._terminate_process_group(mock_proc, grace_seconds=0.01)
            mock_killpg.assert_called()

    async def test_stop_process_group(self):
        mock_proc = MagicMock()
        mock_proc.pid = 99999
        mock_proc.wait = AsyncMock(return_value=0)

        with patch('app.acp_bridge._terminate_process_group', new_callable=AsyncMock) as mock_term:
            await acp_bridge._stop_process_group(mock_proc, grace_seconds=0.01)
            mock_term.assert_called_once_with(mock_proc, 0.01)

    async def test_approval_child_environment_no_team(self):
        with patch.dict(os.environ, {'BOB_TEAM_ID': ''}, clear=True), \
             patch('app.acp_bridge.bob_child_environment', return_value={'BASE': '1'}):
            async with acp_bridge.approval_child_environment('/home/user', '/sock/knowledge') as env:
                self.assertEqual(env.get('BASE'), '1')

    async def test_approval_child_environment_with_team_conflict(self):
        with patch.dict(os.environ, {
            'BOB_TEAM_ID': 'team-xyz',
            'BOB_API_KEY': 'key-a',
            'BOBSHELL_API_KEY': 'key-b',
        }), patch('app.acp_bridge.bob_child_environment', return_value={}):
            with self.assertRaises(RuntimeError):
                async with acp_bridge.approval_child_environment('/home/user', '/sock/knowledge'):
                    pass

    async def test_approval_agent_process(self):
        mock_client = MagicMock()
        mock_proc = MagicMock()
        mock_proc.stdin = MagicMock()
        mock_proc.stdout = MagicMock()
        mock_proc.stderr = MagicMock()
        mock_proc.wait = AsyncMock(return_value=0)

        with patch('app.acp_bridge.sandbox_command', return_value=['bob', 'acp']), \
             patch('asyncio.create_subprocess_exec', new_callable=AsyncMock, return_value=mock_proc), \
             patch('app.acp_bridge.ClientSideConnection') as mock_conn_cls, \
             patch('app.acp_bridge._capture_approval_stderr', new_callable=AsyncMock, return_value='stderr output'), \
             patch('app.acp_bridge._stop_process_group', new_callable=AsyncMock):
            mock_conn = MagicMock()
            mock_conn.close = AsyncMock()
            mock_conn_cls.return_value = mock_conn

            async with acp_bridge.approval_agent_process(mock_client, '/tmp/workspace', {}, disable_mcp=True) as (conn, proc):
                self.assertEqual(conn, mock_conn)
                self.assertEqual(proc, mock_proc)


if __name__ == '__main__':
    unittest.main()
