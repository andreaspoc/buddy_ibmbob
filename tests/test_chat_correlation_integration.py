"""Exercise HTTP correlation routing with model/database calls isolated."""
import json
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from app.main import app, current_user
from app.chat_submission import SubmissionResult


class ChatCorrelationHttpTests(unittest.TestCase):
    def test_request_headers_stream_history_and_validation(self):
        async def stream(*args):
            yield json.dumps({'type': 'done', 'session_id': 'model-session'}) + '\n'
        app.dependency_overrides[current_user] = lambda: {'username': 'fixture-owner'}
        original_stack = app.middleware_stack
        app.middleware_stack = None
        try:
            with ExitStack() as stack:
                stack.enter_context(patch('app.auth.current_user', AsyncMock(return_value={'username': 'fixture-owner'})))
                stack.enter_context(patch('app.main.workspace_for', return_value='/tmp'))
                stack.enter_context(patch('app.main.workspace_key', return_value='fixture-key'))
                stack.enter_context(patch('app.main.list_modes', return_value=[{'slug': 'agent'}]))
                stack.enter_context(patch('app.main.presentation_intent', return_value={'presentation': False}))
                stack.enter_context(patch('app.main.read_history', return_value=[]))
                connection = stack.enter_context(patch('app.main.job_queue._connect'))
                connection.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = None
                stack.enter_context(patch('app.main.storage.get_file', return_value=None))
                stack.enter_context(patch('app.main.execute_event_hooks', AsyncMock(return_value=(True, '', ''))))
                enqueue = stack.enter_context(patch('app.main.job_queue.enqueue', return_value='fixture-job'))
                find = stack.enter_context(patch('app.main.job_queue.find_submission', return_value=None))
                history = stack.enter_context(patch('app.main.append_history'))
                stack.enter_context(patch('app.main.touch_session'))
                stack.enter_context(patch('app.main._stream_job_events', stream))
                client = TestClient(app)
                response = client.post('/chat/stream', json={'prompt': 'hello', 'client_timezone': 'Europe/London'}, headers={'X-Correlation-Id': 'http-trace'})
                self.assertEqual(response.status_code, 200, response.text)
                event = json.loads(response.text)
                self.assertEqual(response.headers['x-correlation-id'], 'http-trace')
                self.assertEqual(event['correlation_id'], 'http-trace')
                self.assertEqual(event['job_id'], 'fixture-job')
                self.assertEqual(event['chat_id'], 'legacy')
                self.assertEqual(event['session_id'], 'model-session')
                self.assertEqual(event['message_id'], response.headers['x-assistant-message-id'])
                self.assertEqual(enqueue.call_args.args[-1]['correlation_id'], 'http-trace')
                self.assertEqual(enqueue.call_args.kwargs['request_event']['message_id'], response.headers['x-user-message-id'])
                history.assert_not_called()  # Request history is committed atomically by enqueue.
                find.return_value = SubmissionResult('fixture-job', enqueue.call_args.args[-1], reused=True)
                replay = client.post('/chat/stream', json={'prompt': 'hello', 'client_timezone': 'Europe/London'}, headers={'X-Correlation-Id': 'http-trace'})
                self.assertEqual(replay.headers['x-idempotency-replayed'], 'true')
                self.assertEqual(replay.headers['x-assistant-message-id'], response.headers['x-assistant-message-id'])
                self.assertEqual(enqueue.call_count, 1)
                find.side_effect = ValueError('Idempotency key was already used for a different request')
                conflict = client.post('/chat/stream', json={'prompt': 'changed', 'idempotency_key': 'http-trace'})
                self.assertEqual(conflict.status_code, 409)
                bad = client.post('/chat/stream', json={'prompt': 'hello', 'correlation_id': 'unsafe id'})
                self.assertEqual(bad.status_code, 422)
                self.assertEqual(enqueue.call_count, 1)
        finally:
            app.dependency_overrides.pop(current_user, None)
            app.middleware_stack = original_stack


if __name__ == '__main__':
    unittest.main()
