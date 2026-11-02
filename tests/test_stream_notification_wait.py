"""Keep one notification reader alive through quiet search/tool intervals."""
import ast
import asyncio
import json
import unittest
from contextlib import aclosing, suppress
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


class NotificationWaitTests(unittest.IsolatedAsyncioTestCase):
    async def test_quiet_interval_reuses_pending_reader(self):
        await self.check_stream(False)

    async def test_missed_completion_replays_saved_result(self):
        await self.check_stream(True)

    async def check_stream(self, completed):
        # Isolate the generator from application startup and database dependencies.
        tree = ast.parse(Path('app/main.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                        and n.name == '_stream_job_events')
        release = asyncio.Event()
        closed = []

        async def notifications(**kwargs):
            try:
                await release.wait()
                yield SimpleNamespace(channel='bob_job_test', payload='{"type":"delta","text":"Answer"}')
                yield SimpleNamespace(channel='bob_job_test', payload='{"type":"done"}')
            finally:
                closed.append(True)

        note_saved = {'type': 'app_action', 'action': 'notes_changed', 'note_id': 42}
        saved_rows = [(10, note_saved), (11, {'type': 'delta', 'text': 'Answer'}), (12, {'type': 'done'})]
        cursor = SimpleNamespace(fetchone=AsyncMock(return_value=('running',)),
                                 fetchall=AsyncMock(side_effect=[[], saved_rows] if completed else [[]]))
        connection = SimpleNamespace(execute=AsyncMock(return_value=cursor),
                                     notifies=notifications, close=AsyncMock())
        readers = []

        async def wait(tasks, timeout):
            readers.append(next(iter(tasks)))
            if len(readers) == 1:
                await asyncio.sleep(0)
                return set(), tasks
            release.set()
            return await asyncio.wait(tasks, timeout=1)

        async def to_thread(function, *args):
            return function(*args)

        namespace = dict(asyncio=SimpleNamespace(create_task=asyncio.create_task, wait=wait,
                                                 CancelledError=asyncio.CancelledError, to_thread=to_thread),
                         job_queue=SimpleNamespace(get_job=lambda job_id: {'status': 'completed' if completed else 'running'}),
                         psycopg=SimpleNamespace(AsyncConnection=SimpleNamespace(connect=AsyncMock(return_value=connection))),
                         os=SimpleNamespace(environ={'DATABASE_URL': 'test'}),
                         aclosing=aclosing, suppress=suppress, json=json)
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'app/main.py', 'exec'), namespace)
        events = [json.loads(item) async for item in namespace['_stream_job_events']('test')]
        if completed:
            self.assertEqual(len(readers), 1)
            replay_query = connection.execute.call_args.args[0]
            self.assertIn("'app_action'", replay_query)
            self.assertEqual(events, [{'type': 'start'}, {**note_saved, 'event_id': 10}, {'type': 'delta', 'text': 'Answer', 'replace': True, 'event_id': 11}, {'type': 'done', 'event_id': 12}])
        else:
            self.assertIs(readers[0], readers[1])
            self.assertEqual(events, [{'type': 'start'}, {'type': 'delta', 'text': 'Answer'}, {'type': 'done'}])
        self.assertEqual(closed, [True])
        connection.close.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
