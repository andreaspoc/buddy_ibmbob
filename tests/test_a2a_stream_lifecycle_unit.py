"""Exercise A2A stream lifecycle with in-process producers only."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.a2a_client import _wait_for_remote_task, stream_message


class StreamLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_yields_updates_before_result_and_forwards_context(self):
        async def send(agent, prompt, context, *, on_event, **kwargs):
            self.assertEqual((agent, prompt, context), ({'name': 'agent'}, 'hello', 'ctx'))
            await on_event({'type': 'delta', 'text': 'hello'})
            await on_event({'type': 'status', 'message': 'done'})
            return {'text': 'hello', 'context_id': 'ctx'}
        with patch('app.a2a_client.send_message', side_effect=send):
            events = [event async for event in stream_message({'name': 'agent'}, 'hello', 'ctx')]
        self.assertEqual(events, [{'type': 'delta', 'text': 'hello'}, {'type': 'status', 'message': 'done'},
                                  {'type': 'a2a_result', 'text': 'hello', 'context_id': 'ctx'}])

    async def test_producer_failure_reaches_consumer(self):
        with patch('app.a2a_client.send_message', new=AsyncMock(side_effect=RuntimeError('unavailable'))):
            with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                _ = [event async for event in stream_message({}, 'hello')]

    async def test_closing_stream_cancels_producer(self):
        canceled = asyncio.Event()
        async def send(agent, prompt, context, *, on_event):
            try:
                await on_event({'type': 'delta', 'text': 'first'})
                await asyncio.Event().wait()
            finally:
                canceled.set()
        with patch('app.a2a_client.send_message', side_effect=send):
            stream = stream_message({}, 'hello')
            self.assertEqual(await anext(stream), {'type': 'delta', 'text': 'first'})
            await stream.aclose()
        self.assertTrue(canceled.is_set())

    async def test_polling_returns_completed_task_and_propagates_errors(self):
        fetch = AsyncMock(side_effect=[{'id': 't', 'status': {'state': 'working'}},
                                       {'id': 't', 'status': {'state': 'completed'}}])
        result = await _wait_for_remote_task({'id': 't', 'status': {'state': 'working'}}, fetch, 1, poll_interval=0)
        self.assertEqual(result['status']['state'], 'completed')
        self.assertEqual(fetch.await_count, 2)
        with self.assertRaisesRegex(RuntimeError, 'network failure'):
            await _wait_for_remote_task({'id': 't', 'status': {'state': 'working'}},
                                        AsyncMock(side_effect=RuntimeError('network failure')), 1, poll_interval=0)

    async def test_unfinished_without_id_and_timeout_are_errors(self):
        with self.assertRaisesRegex(RuntimeError, 'without an ID'):
            await _wait_for_remote_task({'status': {'state': 'working'}}, AsyncMock(), 1)
        started = asyncio.Event()
        canceled = asyncio.Event()
        async def fetch(task_id):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                canceled.set()
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            await _wait_for_remote_task({'id': 't', 'status': {'state': 'working'}}, fetch, 0.05, poll_interval=0)
        self.assertTrue(started.is_set())
        self.assertTrue(canceled.is_set())
