import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import guided_chat as gc


class ResumeTests(unittest.TestCase):
    def test_discovery_ignores_old_and_invalid_known_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'bob.db'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE tasks(id TEXT, first_message TEXT, directory TEXT, parent_id TEXT, task_type TEXT)')
                db.executemany('INSERT INTO tasks VALUES(?,?,?,?,?)', [('old','prompt','/work',None,'normal'), ('new','prompt','/work',None,'normal'), ('wrong','prompt','/other',None,'normal')])
            self.assertEqual(gc.resumed_task(database, 'prompt', '/work', {'old','wrong'}, 'wrong'), 'new')
            self.assertIsNone(gc.resumed_task(database, 'prompt', '/work', set(), None))
            self.assertIsNone(gc.resumed_task(database, 'prompt', '/work', None, None))
            self.assertEqual(gc.resumed_task(database, 'prompt', '/work', None, 'new'), 'new')


class GuidedStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_guidance_stops_old_source_before_restarting(self):
        calls, closed = [], []
        notes = [{'id': 2, 'instruction': 'Focus on latency', 'applied': False}]
        class Bridge:
            async def stream(self, prompt, resume_id, mode, **kwargs):
                calls.append(prompt)
                try:
                    if len(calls) == 1:
                        yield {'type':'delta', 'text':'provisional'}
                        await asyncio.Event().wait()
                    else:
                        self.assert_previous_closed()
                        yield {'type':'done','session_id':'native'}
                finally:
                    closed.append(len(calls))
            def assert_previous_closed(self):
                if closed != [1]:
                    raise AssertionError('New Bob process started before old one closed')
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(gc.chat_guidance, 'open_intake'), \
             patch.object(gc.chat_guidance, 'instructions', side_effect=lambda job_id, pending=False: notes if pending else []), \
             patch.object(gc.chat_guidance, 'applied'), \
             patch.object(gc.chat_guidance, 'close_if_ready', return_value=True), \
             patch.object(gc, 'resumed_task', return_value=None):
            result = await asyncio.wait_for(self.collect(gc.stream_guided_chat(Bridge(), 'original', {'username':'alice','id':'job','worker_token':'token','payload':{}}, workspace=Path(directory), user_home=Path(directory), mode='agent')), 2)
        self.assertEqual(closed, [1,2])
        self.assertIn('provisional', calls[1])
        self.assertIn('Focus on latency', calls[1])
        self.assertEqual(result[-1]['type'], 'done')

    @staticmethod
    async def collect(source):
        return [event async for event in source]

    async def test_guidance_accepted_at_completion_resumes_before_final_delivery(self):
        notes = [{'id': 1, 'instruction': 'Use euros', 'applied': False}]
        calls, closed, marks = [], [], []
        class Bridge:
            async def stream(self, prompt, resume_id, mode, **kwargs):
                calls.append((prompt, resume_id))
                try:
                    yield {'type':'delta', 'text': 'old' if len(calls)==1 else 'updated'}
                    yield {'type':'done', 'session_id':'native'}
                finally:
                    closed.append(len(calls))
        def instructions(job_id, pending=False):
            return notes if pending else []
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(gc.chat_guidance, 'open_intake'), \
             patch.object(gc.chat_guidance, 'instructions', side_effect=instructions), \
             patch.object(gc.chat_guidance, 'applied', side_effect=lambda *args: marks.append(args[-1])), \
             patch.object(gc.chat_guidance, 'close_if_ready', side_effect=[False, True]), \
             patch.object(gc, 'resumed_task', return_value='native'):
            result = [event async for event in gc.stream_guided_chat(Bridge(), 'original', {'username':'alice','id':'job','worker_token':'token','payload':{}}, workspace=Path(directory), user_home=Path(directory), mode='agent')]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][1], 'native')
        self.assertIn('Use euros', calls[1][0])
        self.assertEqual(closed, [1, 2])
        self.assertEqual(marks, [[1]])
        self.assertEqual(sum(event['type']=='done' for event in result), 1)
        self.assertIn({'type':'delta','text':'','replace':True}, result)

    async def test_cancellation_closes_bob_generator(self):
        entered, closed = asyncio.Event(), asyncio.Event()
        class Bridge:
            async def stream(self, *args, **kwargs):
                try:
                    entered.set()
                    await asyncio.Event().wait()
                    yield {}
                finally:
                    closed.set()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(gc.chat_guidance, 'open_intake'), \
             patch.object(gc.chat_guidance, 'instructions', return_value=[]):
            stream = gc.stream_guided_chat(Bridge(), 'request', {'username':'alice','id':'job','worker_token':'token','payload':{}}, workspace=Path(directory), user_home=Path(directory), mode='agent')
            task = asyncio.create_task(anext(stream))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(closed.is_set())
            await stream.aclose()

if __name__ == '__main__':
    unittest.main()
