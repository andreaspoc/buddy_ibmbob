"""Exercise streamed Office completions, cancellation, and safe error handling."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from buddy_office import office_ai


class OfficeStreamTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        office_ai._active.clear()
        self.req = office_ai.Completion(messages=[{'role': 'user', 'content': 'Rewrite this'}], stream=True)

    async def test_success_streams_text_and_releases_user(self):
        async def run(req, language, emit):
            await emit('First ')
            await emit('answer')
            return 'First answer'
        office_ai._active.add('fixture')
        with patch.object(office_ai, 'run_acp', side_effect=run):
            events = [event async for event in office_ai.completion_events(self.req, 'en', AsyncMock(is_disconnected=AsyncMock(return_value=False)), 'fixture')]
        self.assertTrue(any('First ' in event for event in events))
        self.assertTrue(any('answer' in event for event in events))
        self.assertTrue(any('"finish_reason": "stop"' in event for event in events))
        self.assertEqual(events[-1], 'data: [DONE]\n\n')
        self.assertNotIn('fixture', office_ai._active)

    async def test_failure_does_not_leak_exception_or_user_text(self):
        office_ai._active.add('fixture')
        with patch.object(office_ai, 'run_acp', new=AsyncMock(side_effect=RuntimeError('secret diagnostic'))):
            events = [event async for event in office_ai.completion_events(self.req, 'en', AsyncMock(is_disconnected=AsyncMock(return_value=False)), 'fixture')]
        self.assertIn('bob_acp_error', ''.join(events))
        self.assertNotIn('secret diagnostic', ''.join(events))
        self.assertEqual(events[-1], 'data: [DONE]\n\n')
        self.assertNotIn('fixture', office_ai._active)

    async def test_disconnected_client_cancels_work_and_clears_active(self):
        cancelled = asyncio.Event()
        async def run(req, language, emit):
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.set()
        async def disconnected():
            await asyncio.sleep(0)
            return True
        office_ai._active.add('fixture')
        with patch.object(office_ai, 'run_acp', side_effect=run):
            events = [event async for event in office_ai.completion_events(self.req, 'en', AsyncMock(is_disconnected=disconnected), 'fixture')]
        self.assertEqual(events, [])
        self.assertTrue(cancelled.is_set())
        self.assertNotIn('fixture', office_ai._active)


if __name__ == '__main__':
    unittest.main()
