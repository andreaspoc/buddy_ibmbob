import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.chat_correlation import correlate_stream, request_ids, turn_metadata
from app.job_queue import JobStreamRecorder
from app.chat_submission import fingerprint


class CorrelationTests(unittest.IsolatedAsyncioTestCase):
    def test_request_fingerprint_ignores_retry_routing_but_covers_content(self):
        original = {'prompt': 'first', 'correlation_id': 'trace-a', 'user_message_id': 'user-a',
                    'assistant_message_id': 'assistant-a', 'idempotency_key': 'key',
                    'approval_policy': {'mode': 'auto', 'actions': ['files']}}
        retry = {**original, 'correlation_id': 'trace-b', 'user_message_id': 'user-b',
                 'assistant_message_id': 'assistant-b'}
        self.assertEqual(fingerprint(original), fingerprint(retry))
        self.assertNotEqual(fingerprint(original), fingerprint({**retry, 'prompt': 'changed'}))

    def test_ids_generated_and_validated(self):
        values = request_ids({}, 'trace-from-client')
        self.assertEqual(values['correlation_id'], 'trace-from-client')
        self.assertNotEqual(values['user_message_id'], values['assistant_message_id'])
        self.assertEqual(request_ids(values), values)
        for invalid in ('bad\r\nheader', ' ', 'a' * 129, []):
            with self.assertRaises(ValueError):
                request_ids({'correlation_id': invalid} if invalid else {}, invalid)

    async def test_envelope_preserves_model_session_and_overrides_untrusted_routing(self):
        ids = request_ids({})
        metadata = turn_metadata(ids, 'chat', 'job')
        async def source():
            yield json.dumps({'type': 'done', 'session_id': 'model-session', 'job_id': 'wrong'})
        events = [json.loads(line) async for line in correlate_stream(source(), metadata)]
        self.assertEqual(events[0]['session_id'], 'model-session')
        self.assertEqual(events[0]['job_id'], 'job')
        self.assertEqual(events[0]['chat_id'], 'chat')
        self.assertEqual(events[0]['message_id'], ids['assistant_message_id'])

    async def test_durable_and_live_metadata_share_cursor_and_terminal_message(self):
        ids = request_ids({})
        recorder = JobStreamRecorder('job', 'token', 'owner', 'chat', durable=True, correlation=ids)
        recorder._conn = SimpleNamespace(closed=False, execute=AsyncMock())
        with patch.object(recorder, '_persist_event', return_value=41) as persist:
            await recorder.record_event({'type': 'artifact', 'content': 'new', 'job_id': 'wrong'})
            stored = persist.call_args.args[-1]
            self.assertEqual(stored['correlation_id'], ids['correlation_id'])
            self.assertEqual(stored['job_id'], 'job')
        live = json.loads(recorder._conn.execute.call_args.args[1][1])
        self.assertEqual(live['event_id'], 41)
        self.assertEqual(live['message_id'], ids['assistant_message_id'])
        self.assertEqual(recorder.workflow_events, [])
        with patch.object(recorder, '_persist_event', return_value=42):
            await recorder.record_event({'type': 'delta', 'text': 'answer'})
        with patch.object(recorder, '_persist_completion') as persist:
            await recorder.finish({'type': 'done', 'session_id': 'bob-session'})
            terminal = persist.call_args.args[-1]
            self.assertEqual(terminal['session_id'], 'bob-session')
            self.assertEqual(terminal['correlation_id'], ids['correlation_id'])


if __name__ == '__main__':
    unittest.main()
