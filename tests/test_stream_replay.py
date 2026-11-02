"""Replay follows stable database cursors and releases its read connection."""
import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

module = ast.parse(Path('app/main.py').read_text())
function = next(node for node in module.body if isinstance(node, ast.AsyncFunctionDef) and node.name == '_replay_job_events')


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    def replay(self, pages):
        connection = SimpleNamespace(close=AsyncMock())
        queue = SimpleNamespace(stream_reader=AsyncMock(return_value=connection), read_stream_events=AsyncMock(side_effect=pages))
        namespace = {'asyncio': asyncio, 'json': json, 'job_queue': queue}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<replay>', 'exec'), namespace)
        return namespace['_replay_job_events'], connection, queue

    async def test_cursor_and_terminal_page(self):
        replay, connection, queue = self.replay([([{'id': 12, 'event': {'type': 'done'}}], 'completed')])
        events = [json.loads(line) async for line in replay('job', 11)]
        self.assertEqual(events, [{'type': 'done', 'event_id': 12}])
        queue.read_stream_events.assert_awaited_once_with(connection, 'job', 11)
        connection.close.assert_awaited_once()

    async def test_full_terminal_page_is_drained(self):
        rows = [{'id': index, 'event': {'type': 'status'}} for index in range(1, 201)]
        replay, connection, queue = self.replay([(rows, 'completed'), ([{'id': 201, 'event': {'type': 'done'}}], 'completed')])
        events = [json.loads(line) async for line in replay('job')]
        self.assertEqual(events[-1], {'type': 'done', 'event_id': 201})
        self.assertEqual(queue.read_stream_events.await_args_list[-1].args[-1], 200)
        connection.close.assert_awaited_once()

    async def test_reader_error_closes_connection(self):
        replay, connection, queue = self.replay(RuntimeError('disconnected'))
        with self.assertRaises(RuntimeError):
            await anext(replay('job'))
        connection.close.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
