"""Calendar boundaries and bounded delegation without Bob/network dependencies."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from contextlib import aclosing
from datetime import datetime, timezone
from pydantic import ValidationError
from app.workflows import WorkflowSpec, next_run
from app.team_runs import stream_workflow, review_verdict
from app.job_queue import JobStreamRecorder

UTC = timezone.utc


class ScheduleTests(unittest.TestCase):
    def test_weekly_timezone_and_strictly_future(self):
        spec = WorkflowSpec(name='Report', prompt='Prepare report', frequency='weekly', timezone='Europe/Athens', time='09:00', weekday=0)
        due = next_run(spec, datetime(2026, 10, 5, 6, 0, tzinfo=UTC))
        self.assertEqual(due, datetime(2026, 10, 12, 6, 0, tzinfo=UTC))

    def test_dst_nonexistent_time_is_skipped(self):
        spec = WorkflowSpec(name='Report', prompt='Prepare report', frequency='daily', timezone='Europe/Berlin', time='02:30')
        self.assertEqual(next_run(spec, datetime(2026, 3, 28, 23, 0, tzinfo=UTC)), datetime(2026, 3, 30, 0, 30, tzinfo=UTC))

    def test_dst_repeated_time_runs_once(self):
        spec = WorkflowSpec(name='Report', prompt='Prepare report', frequency='daily', timezone='Europe/Berlin', time='02:30')
        self.assertEqual(next_run(spec, datetime(2026, 10, 25, 0, 31, tzinfo=UTC)), datetime(2026, 10, 26, 1, 30, tzinfo=UTC))

    def test_manual_and_validation(self):
        self.assertIsNone(next_run(WorkflowSpec(name='Report', prompt='Prepare report'), datetime.now(UTC)))
        for args in ({'timezone': 'No/SuchZone'}, {'roles': ['']}, {'roles': ['a'] * 4}, {'max_iterations': 2}, {'prompt': '  '}, {'presentation_format': 'pptx'}):
            with self.assertRaises(ValidationError):
                WorkflowSpec(**({'name': 'Report', 'prompt': 'Prepare report'} | args))


class FakeBridge:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []
        self.closed = 0

    async def stream(self, prompt, *args, **kwargs):
        self.calls.append((prompt, args, kwargs))
        try:
            yield {'type': 'start'}
            yield {'type': 'delta', 'text': next(self.replies)}
            yield {'type': 'done', 'session_id': 'fake', 'tokens': 10, 'cost': 0.1}
        finally:
            self.closed += 1


async def collect(bridge, **values):
    spec = WorkflowSpec(**({'name': 'test', 'prompt': 'task'} | values)).model_dump()
    return [event async for event in stream_workflow(bridge, 'task', spec, workspace='/tmp', user_home='/tmp', mode='agent')]


class TeamTests(unittest.IsolatedAsyncioTestCase):
    async def test_normal_chat_recorder_remains_batched(self):
        recorder = JobStreamRecorder('test', 'token', 'owner', 'session')
        recorder._conn = SimpleNamespace(closed=False, execute=AsyncMock())
        await recorder.record_event({'type': 'status', 'message': 'working'})
        await recorder.record_event({'type': 'delta', 'text': 'old draft'})
        await recorder.record_event({'type': 'delta', 'text': 'answer', 'replace': True})
        with patch.object(recorder, '_persist_completion') as persist:
            await recorder.finish({'type': 'done'})
            self.assertEqual(persist.call_args.args[4], [{'type': 'status', 'message': 'working'}])
            self.assertEqual(persist.call_args.args[5], 'answer')

    async def test_durable_recorder_commits_before_live_delivery(self):
        recorder = JobStreamRecorder('test', 'token', 'owner', 'session', durable=True)
        recorder._conn = SimpleNamespace(closed=False, execute=AsyncMock())
        event = {'type': 'status', 'message': 'Preparing answer'}
        with patch.object(recorder, '_persist_event', return_value=True) as persist:
            self.assertTrue(await recorder.record_event(event))
            persist.assert_called_once_with('test', 'token', 'owner', 'session', event)
        self.assertEqual(recorder.accumulated_text, [])
        recorder._conn.execute.assert_awaited_once()

    async def test_durable_commit_survives_live_notification_failure(self):
        recorder = JobStreamRecorder('test', 'token', 'owner', 'session', durable=True)
        recorder._conn = SimpleNamespace(closed=False, execute=AsyncMock(side_effect=RuntimeError('notice disconnected')))
        with patch.object(recorder, '_persist_event', return_value=True):
            self.assertTrue(await recorder.record_event({'type': 'status', 'message': 'Committed progress'}))

    def test_review_fences_and_strict_schema(self):
        self.assertTrue(review_verdict('```json\n{"complete":true,"feedback":"Verified"}\n```')['complete'])
        for text in ('Prefix {"complete":true,"feedback":"okay"}', '{"complete":"true","feedback":"okay"}', '{"complete":true}', '[]'):
            with self.assertRaises(ValueError):
                review_verdict(text)

    async def test_roles_feed_coordinator_and_no_private_deltas(self):
        bridge = FakeBridge(['Research findings', 'Analysis findings', 'Combined result'])
        events = await collect(bridge, roles=['Researcher', 'Analyst'])
        self.assertEqual([e['text'] for e in events if e['type'] == 'delta'], ['Combined result'])
        self.assertIn('Research findings', bridge.calls[-1][0])
        self.assertIn('Analysis findings', bridge.calls[-1][0])
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(events[-1]['tokens'], 30)
        self.assertEqual(bridge.closed, 3)

    async def test_review_continues_then_completes(self):
        bridge = FakeBridge(['Draft', '{"complete":false,"feedback":"Add evidence"}', 'Fixed', '{"complete":true,"feedback":"Verified"}'])
        events = await collect(bridge, max_iterations=2, completion_criteria='All claims cited')
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(events[-1]['iterations'], 2)
        self.assertIn('Add evidence', bridge.calls[2][0])
        self.assertTrue(any(e.get('replace') for e in events))
        self.assertEqual(bridge.calls[1][1], (None, 'ask'))

    async def test_invalid_review_fails_at_limit(self):
        bridge = FakeBridge(['Draft', 'I think it is good'])
        events = await collect(bridge, completion_criteria='Cited')
        self.assertEqual(events[-1]['type'], 'error')
        self.assertIn('Iteration limit', events[-1]['message'])
        self.assertEqual(len(bridge.calls), 2)

    async def test_cancellation_closes_child_stream(self):
        class SlowBridge:
            closed = False
            async def stream(self, *args, **kwargs):
                try:
                    yield {'type': 'status', 'message': 'working'}
                    await asyncio.sleep(100)
                finally:
                    self.closed = True
        bridge = SlowBridge()
        task = asyncio.create_task(collect(bridge))
        await asyncio.sleep(.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(bridge.closed)


if __name__ == '__main__':
    unittest.main()
