"""Synthetic remote task states exercise notification, deadline and cleanup behavior."""
import asyncio
import unittest
from unittest.mock import AsyncMock

from app.a2a_client import _wait_for_remote_task


def task(state='working'):
    return {'id': 'fixture-task', 'status': {'state': state}}


class RemoteTaskNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_task_does_not_start_a_request(self):
        fetch = AsyncMock()
        original = task('completed')
        self.assertIs(await _wait_for_remote_task(original, fetch, .1), original)
        fetch.assert_not_awaited()

    async def test_updates_signal_completion_without_overlapping_requests(self):
        fetch = AsyncMock(side_effect=[task(), task('completed')])
        result = await _wait_for_remote_task(task(), fetch, 1, poll_interval=.001)
        self.assertEqual(result, task('completed'))
        self.assertEqual(fetch.await_count, 2)
        fetch.assert_awaited_with('fixture-task')

    async def test_request_error_reaches_the_waiter(self):
        failure = RuntimeError('Synthetic remote failure')
        with self.assertRaises(RuntimeError) as caught:
            await _wait_for_remote_task(task(), AsyncMock(side_effect=failure), 1, poll_interval=.001)
        self.assertIs(caught.exception, failure)

    async def test_unfinished_task_without_id_is_rejected(self):
        fetch = AsyncMock()
        with self.assertRaisesRegex(RuntimeError, 'without an ID'):
            await _wait_for_remote_task({'status': {'state': 'working'}}, fetch, .1)
        fetch.assert_not_awaited()
        with self.assertRaisesRegex(RuntimeError, 'without an ID'):
            await _wait_for_remote_task(task(), AsyncMock(return_value={'status': {'state': 'working'}}), 1, poll_interval=.001)

    async def test_timeout_cancels_and_drains_active_request(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def fetch(_identity):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        pending = asyncio.create_task(_wait_for_remote_task(task(), fetch, .2, poll_interval=.001))
        await asyncio.wait_for(started.wait(), 1)
        with self.assertRaisesRegex(RuntimeError, 'response is incomplete'):
            await pending
        self.assertTrue(cancelled.is_set())

    async def test_caller_cancellation_cancels_and_drains_request(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def fetch(_identity):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        pending = asyncio.create_task(_wait_for_remote_task(task(), fetch, 1, poll_interval=.001))
        await asyncio.wait_for(started.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(cancelled.is_set())

    async def test_cancellation_before_timer_fires_starts_no_request(self):
        fetch = AsyncMock()
        waiting = asyncio.Event()
        async def run():
            waiting.set()
            return await _wait_for_remote_task(task(), fetch, 10)
        pending = asyncio.create_task(run())
        await asyncio.wait_for(waiting.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        fetch.assert_not_awaited()

    async def test_input_required_is_a_stop_state(self):
        result = await _wait_for_remote_task(task(), AsyncMock(return_value=task('input-required')), 1, poll_interval=.001)
        self.assertEqual(result, task('input-required'))

    async def test_remote_request_cancellation_reaches_the_waiter(self):
        fetch = AsyncMock(side_effect=asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError):
            await _wait_for_remote_task(task(), fetch, 1, poll_interval=.001)
        fetch.assert_awaited_once()

    async def test_second_caller_cancellation_during_cleanup_propagates(self):
        started, cleanup_started = asyncio.Event(), asyncio.Event()
        async def fetch(_identity):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_started.set()
                await asyncio.Event().wait()
        pending = asyncio.create_task(_wait_for_remote_task(task(), fetch, 1, poll_interval=.001))
        await asyncio.wait_for(started.wait(), 1)
        pending.cancel()
        await asyncio.wait_for(cleanup_started.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending

    async def test_nonstreaming_protocols_finish_once_without_resubmitting_prompt(self):
        import json
        import httpx
        from unittest.mock import patch
        from app import a2a_client
        original_wait = a2a_client._wait_for_remote_task
        async def quick_wait(current, fetch, timeout):
            return await original_wait(current, fetch, timeout, poll_interval=.001)
        for version, send, get in [('0.3', 'message/send', 'tasks/get'), ('1.0', 'SendMessage', 'GetTask')]:
            methods = []
            def handle(request):
                payload = json.loads(request.content)
                methods.append(payload['method'])
                if payload['method'] == send:
                    return httpx.Response(200, json={'result': task()})
                self.assertEqual(payload['params'], {'id': 'fixture-task'})
                completed = {**task('completed'), 'contextId': 'fixture-context',
                             'artifacts': [{'parts': [{'text': 'Synthetic answer'}]}]}
                return httpx.Response(200, json={'result': completed})
            client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
            with patch.object(a2a_client.httpx, 'AsyncClient', return_value=client), \
                    patch.object(a2a_client, '_wait_for_remote_task', side_effect=quick_wait):
                result = await a2a_client.send_message({'protocol_version': version,
                    'endpoint': 'https://example.test', 'streaming': False}, 'Synthetic request')
            self.assertEqual(result, {'text': 'Synthetic answer', 'context_id': 'fixture-context'})
            self.assertEqual(methods, [send, get])
