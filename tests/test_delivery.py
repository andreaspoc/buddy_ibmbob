"""Lifecycle milestones represent observed transitions with stable routing."""
import json
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.chat_correlation import request_ids
from app.delivery import delivery_event, terminal_state
from app.job_queue import JobStreamRecorder


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    def test_timestamp_and_terminal_states(self):
        event = delivery_event('running', {'workspace_id': 'chat', 'job_id': 'job', **request_ids({})})
        self.assertIsNotNone(datetime.fromisoformat(event['timestamp']).tzinfo)
        self.assertEqual(event['chat_id'], 'chat')
        self.assertEqual(terminal_state({'type': 'done'}), 'completed')
        self.assertEqual(terminal_state({'type': 'error', 'cancelled': True}), 'cancelled')
        self.assertEqual(terminal_state({'type': 'error'}), 'failed')
        with self.assertRaises(ValueError):
            delivery_event('invented', {})

    async def test_first_text_records_one_streaming_milestone_before_text(self):
        recorder = JobStreamRecorder('job', 'worker', 'user', 'chat', durable=True, correlation=request_ids({}))
        recorder._conn = SimpleNamespace(closed=False, execute=AsyncMock())
        with patch.object(recorder, '_persist_event', return_value=12) as persist:
            await recorder.record_event({'type': 'delta', 'text': ''})
            self.assertEqual(persist.call_count, 0)
            await recorder.record_event({'type': 'delta', 'text': 'first'})
            await recorder.record_event({'type': 'delta', 'text': ' second'})
            self.assertEqual(persist.call_count, 1)
            milestone = persist.call_args.args[-1]
            self.assertEqual(milestone['state'], 'streaming')
            self.assertEqual(milestone['message_id'], recorder.correlation['assistant_message_id'])
        events = [json.loads(call.args[1][1]) for call in recorder._conn.execute.call_args_list]
        self.assertEqual([event['type'] for event in events], ['delta', 'delivery_state', 'delta', 'delta'])
        self.assertEqual(recorder.accumulated_text, ['','first',' second'])

    async def test_ready_answer_is_checkpointed_before_background_file_save(self):
        recorder = JobStreamRecorder('job', 'worker', 'user', 'chat', durable=True, correlation=request_ids({}))
        recorder.accumulated_text = ['Finished ', 'answer']
        recorder._conn = SimpleNamespace(closed=False, execute=AsyncMock())
        with patch.object(recorder, '_persist_event', return_value=12) as persist:
            await recorder.record_event(delivery_event('saving', recorder.correlation))
        snapshot, milestone = [call.args[-1] for call in persist.call_args_list]
        self.assertEqual(snapshot['type'], 'delta')
        self.assertEqual(snapshot['text'], 'Finished answer')
        self.assertTrue(snapshot['replace'])
        self.assertEqual(milestone['state'], 'saving')

    async def test_artifact_has_observed_timestamp(self):
        recorder = JobStreamRecorder('job', 'worker', 'user', 'chat', durable=True, correlation=request_ids({}))
        recorder._conn = SimpleNamespace(closed=False, execute=AsyncMock())
        with patch.object(recorder, '_persist_event', return_value=8) as persist:
            await recorder.record_event({'type': 'artifact', 'path': 'page.html', 'content': 'draft'})
            self.assertIsNotNone(datetime.fromisoformat(persist.call_args.args[-1]['timestamp']).tzinfo)


if __name__ == '__main__':
    unittest.main()
