from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from starlette.testclient import TestClient

from app.gateway import app


class TestGatewayEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_ready_endpoint(self):
        resp = self.client.get("/ready")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("service"), "bob-gateway")

    def test_health_endpoint(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "healthy")

    def test_prompt_with_browser_timezone_is_accepted_and_streamed(self):
        async def authenticate(request):
            return {'username': 'synthetic-user', 'is_admin': False}

        async def events():
            yield '{"type":"done"}\n'

        response = StreamingResponse(events(), headers={
            'X-Bob-Job-Id': 'synthetic-job', 'X-Correlation-Id': 'synthetic-turn'})
        with patch('app.gateway.current_user', authenticate), patch('app.main.chat_stream', new_callable=AsyncMock, return_value=response) as stream:
            with self.client.websocket_connect('/ws/gateway', headers={'origin': 'http://testserver', 'host': 'testserver'}) as socket:
                self.assertEqual(socket.receive_json()['type'], 'gateway_ready')
                socket.send_json({'action': 'prompt', 'prompt': 'Synthetic request',
                                  'client_timezone': 'Europe/London', 'correlation_id': 'synthetic-turn'})
                self.assertEqual(socket.receive_json()['type'], 'accepted')
                self.assertEqual(socket.receive_json()['type'], 'done')
        self.assertEqual(stream.await_args.args[0].client_timezone, 'Europe/London')

    def test_invalid_timezone_returns_error_without_losing_connection(self):
        async def authenticate(request):
            return {'username': 'synthetic-user', 'is_admin': False}

        with patch('app.gateway.current_user', authenticate), patch('app.main.chat_stream', new_callable=AsyncMock) as stream:
            with self.client.websocket_connect('/ws/gateway', headers={'origin': 'http://testserver', 'host': 'testserver'}) as socket:
                self.assertEqual(socket.receive_json()['type'], 'gateway_ready')
                socket.send_json({'action': 'prompt', 'prompt': 'Synthetic request', 'client_timezone': 'Invalid/Timezone'})
                self.assertEqual(socket.receive_json()['type'], 'error')
                socket.send_json({'action': 'ping'})
                self.assertEqual(socket.receive_json()['type'], 'pong')
        stream.assert_not_awaited()

    def test_unauthenticated_websocket_rejected(self):
        with self.assertRaises(Exception):
            with self.client.websocket_connect("/ws/gateway"):
                pass

    def test_websocket_closes_when_session_revoked_on_action(self):
        state = {'live': True, 'auth_calls': 0}
        async def authenticate(request):
            state['auth_calls'] += 1
            if not state['live']:
                raise HTTPException(401, 'Synthetic session revoked')
            return {'username': 'test-user', 'is_admin': False}

        with patch("app.gateway.current_user", authenticate):
            with self.client.websocket_connect('/ws/gateway', headers={'origin': 'http://testserver', 'host': 'testserver'}) as socket:
                self.assertEqual(socket.receive_json()['type'], 'gateway_ready')
                state['live'] = False
                socket.send_json({'action': 'cancel', 'job_id': '11111111-1111-4111-8111-111111111111'})
                with self.assertRaises(Exception):
                    socket.receive_json()
        self.assertEqual(state['auth_calls'], 2)

    def test_websocket_cancel_approval_guidance_actions(self):
        async def authenticate(request):
            return {'username': 'user1', 'is_admin': False}

        with patch('app.gateway.current_user', authenticate), \
             patch('app.main.cancel_job', new_callable=AsyncMock, return_value={'status': 'cancelled'}), \
             patch('app.main.decide_job_approval', new_callable=AsyncMock, return_value={'type': 'decided'}), \
             patch('app.main.guide_chat', new_callable=AsyncMock, return_value={'guided': True}):
            with self.client.websocket_connect('/ws/gateway', headers={'origin': 'http://testserver', 'host': 'testserver'}) as socket:
                self.assertEqual(socket.receive_json()['type'], 'gateway_ready')

                # cancel
                socket.send_json({'action': 'cancel', 'job_id': '11111111-1111-4111-8111-111111111111'})
                self.assertEqual(socket.receive_json()['type'], 'cancel_ack')

                # approval
                socket.send_json({'action': 'approval', 'job_id': '11111111-1111-4111-8111-111111111111',
                                  'approval_id': 'app-1', 'decision': 'approve'})
                self.assertEqual(socket.receive_json()['type'], 'approval_ack')

                # guidance
                socket.send_json({'action': 'guidance', 'job_id': '11111111-1111-4111-8111-111111111111',
                                  'instruction': 'focus on section 2'})
                self.assertEqual(socket.receive_json()['type'], 'guidance_ack')

                # ping
                socket.send_json({'action': 'ping'})
                self.assertEqual(socket.receive_json()['type'], 'pong')


if __name__ == "__main__":
    unittest.main()
