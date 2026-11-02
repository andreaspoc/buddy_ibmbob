"""WebSocket signaling behavior without a database or real call participants."""
import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
from uuid import uuid4
from fastapi import APIRouter, HTTPException, WebSocketDisconnect
from buddy_people import community, community_call_audio, community_calls as calls


class Socket:
    def __init__(self, messages=(), origin='https://buddy.invalid', audio='1'):
        self.headers = {'origin': origin, 'host': 'buddy.invalid'}
        self.query_params = {'audio': audio}
        self.messages = iter(messages)
        self.sent = []
        self.closed = []
        self.accepted = False

    async def accept(self): self.accepted = True
    async def close(self, code=1000): self.closed.append(code)
    async def send_json(self, value): self.sent.append(value)
    async def receive_text(self):
        try: return next(self.messages)
        except StopIteration: raise WebSocketDisconnect()


class DB:
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def execute(self, sql): self.sql = sql
    async def notifies(self, **kwargs):
        await asyncio.Event().wait()
        yield None


class VoiceSocketTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.auth = AsyncMock(return_value={'username': 'alice'})
        router = APIRouter()
        calls.register(router, self.auth)
        self.endpoint = router.routes[0].endpoint

    async def run_socket(self, socket, *, transport='webrtc', handle=None):
        with patch.object(community, 'ensure_schema'), \
             patch.object(community_call_audio, 'transport', return_value=transport), \
             patch.object(calls, 'ice_servers', return_value=[]), \
             patch.object(calls, 'heartbeat', return_value=[]), \
             patch.object(calls, 'handle', side_effect=handle or (lambda *args: {'type': 'call_state'})), \
             patch.object(calls, 'disconnect') as disconnect, \
             patch.object(calls.psycopg.AsyncConnection, 'connect', new=AsyncMock(return_value=DB())), \
             patch.dict(os.environ, {'DATABASE_URL': 'postgresql://unused'}):
            await self.endpoint(socket)
            if socket.accepted: disconnect.assert_called_once()

    async def test_rejects_cross_origin_before_authentication(self):
        socket = Socket(origin='https://elsewhere.invalid')
        await self.endpoint(socket)
        self.assertEqual(socket.closed, [1008])
        self.auth.assert_not_awaited()

    async def test_signaling_validates_messages_and_returns_action_results(self):
        socket = Socket(['not-json', json.dumps({'action':'ping'}), json.dumps({'action':'start','room_id':3})])
        await self.run_socket(socket)
        self.assertTrue(socket.accepted)
        self.assertEqual([message['type'] for message in socket.sent],
                         ['call_ready', 'call_error', 'call_ready', 'call_state'])
        self.assertEqual(socket.sent[1]['message'], 'Unsupported voice call message')
        self.assertEqual(socket.closed, [1000])

    async def test_old_client_is_told_to_reload_for_websocket_audio(self):
        socket = Socket([json.dumps({'action':'start','room_id':3})], audio='0')
        await self.run_socket(socket, transport='websocket')
        errors = [message['message'] for message in socket.sent if message['type'] == 'call_error']
        self.assertEqual(len(errors), 2)
        self.assertTrue(all('Reload Buddy' in message for message in errors))

    async def test_action_error_is_returned_without_closing_early(self):
        socket = Socket([json.dumps({'action':'start','room_id':3})])
        def reject(*args): raise HTTPException(409, 'Already in a call')
        await self.run_socket(socket, handle=reject)
        self.assertEqual(socket.sent[-1], {'type':'call_error', 'message':'Already in a call'})

    async def test_oversized_message_disconnects(self):
        socket = Socket(['x' * 8193])
        await self.run_socket(socket)
        self.assertEqual([m['type'] for m in socket.sent], ['call_ready'])

    async def test_listener_forwards_only_owned_active_signals(self):
        call_id = str(uuid4())
        socket = Socket()
        sent_signal = asyncio.Event()

        async def send(value):
            socket.sent.append(value)
            if value.get('type') == 'call_signal': sent_signal.set()

        async def receive():
            await asyncio.wait_for(sent_signal.wait(), timeout=2)
            raise WebSocketDisconnect()

        socket.send_json = send
        socket.receive_text = receive

        class NotificationDB(DB):
            async def notifies(self, **kwargs):
                if getattr(self, 'delivered', False):
                    await asyncio.Event().wait()
                self.delivered = True
                client_id = socket.sent[0]['client_id']
                for payload in [
                    {'kind':'signal', 'target':'another-tab', 'call_id':call_id},
                    {'kind':'state', 'call_id':call_id},
                    {'kind':'signal', 'target':client_id, 'call_id':call_id,
                     'action':'offer', 'sdp':'v=0'},
                ]:
                    yield SimpleNamespace(payload=json.dumps(payload))

        state = {'type':'call_state', 'call':{'transport':'webrtc', 'owned':True, 'status':'accepted'}}
        with patch.object(community, 'ensure_schema'), \
             patch.object(community_call_audio, 'transport', return_value='webrtc'), \
             patch.object(calls, 'ice_servers', return_value=[]), \
             patch.object(calls, 'heartbeat', return_value=[]), \
             patch.object(calls, 'state', return_value=state) as read_state, \
             patch.object(calls, 'disconnect'), \
             patch.object(calls.psycopg.AsyncConnection, 'connect', new=AsyncMock(return_value=NotificationDB())), \
             patch.dict(os.environ, {'DATABASE_URL':'postgresql://unused'}):
            await self.endpoint(socket)
        self.assertEqual(read_state.call_count, 2)
        self.assertEqual(socket.sent[1:3], [state, {'type':'call_signal', 'call_id':call_id, 'action':'offer', 'sdp':'v=0'}])
        self.assertEqual(socket.sent[3], {'type':'call_ping'})

class VoiceProtocolTests(unittest.TestCase):
    def test_only_audio_sdp_is_accepted(self):
        call_id = uuid4()
        valid = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
        self.assertEqual(calls.Signal(action='offer', call_id=call_id, sdp=valid).sdp, valid)
        for sdp in ['', 'v=0\r\nm=video 9 UDP 1\r\n', valid + 'm=application 9 UDP 1\r\n']:
            with self.subTest(sdp=sdp), self.assertRaises(ValueError):
                calls.Signal(action='offer', call_id=call_id, sdp=sdp)

    def test_ice_fields_are_bounded_and_allow_only_negotiation_metadata(self):
        call_id = uuid4()
        valid = {'candidate':'candidate:1', 'sdpMid':'0', 'sdpMLineIndex':0, 'usernameFragment':'ufrag'}
        self.assertEqual(calls.Signal(action='ice', call_id=call_id, candidate=valid).candidate, valid)
        for bad in [None, {'candidate':'x', 'unexpected':'x'}, {'candidate':1},
                    {'candidate':'x'*1801}, {'candidate':'x', 'sdpMid':'a'*33},
                    {'candidate':'x', 'sdpMLineIndex':True}, {'candidate':'x', 'sdpMLineIndex':9},
                    {'candidate':'x', 'usernameFragment':'a'*257}]:
            with self.subTest(candidate=bad), self.assertRaises(ValueError):
                calls.Signal(action='ice', call_id=call_id, candidate=bad)

    def test_signal_fields_match_action(self):
        for value in [{'action':'start'}, {'action':'ping','room_id':1},
                      {'action':'accept'}, {'action':'connected','call_id':str(uuid4()),'reason':'hangup'}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                calls.Signal.model_validate(value)

    def test_turn_credentials_are_generated_for_authenticated_username(self):
        import base64
        import hashlib
        import hmac
        env = {'PEOPLE_ICE_SERVERS':'[]', 'PEOPLE_TURN_URLS':'["turn:relay.example.invalid"]',
               'PEOPLE_TURN_SECRET':'s'*32}
        with patch.dict(os.environ, env), patch.object(calls.time, 'time', return_value=1000):
            servers = calls.ice_servers('alice')
        username = str(1000 + 13*3600) + ':' + hashlib.sha256(b'alice').hexdigest()[:24]
        expected = base64.b64encode(hmac.new(b's'*32, username.encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(servers, [{'urls':['turn:relay.example.invalid'], 'username':username, 'credential':expected}])

    def test_invalid_ice_configuration_fails_closed(self):
        examples = [
            {'PEOPLE_ICE_SERVERS':'{}'},
            {'PEOPLE_ICE_SERVERS':'[1]'},
            {'PEOPLE_ICE_SERVERS':'[{"urls":"https://bad.invalid"}]'},
            {'PEOPLE_ICE_SERVERS':'[{"urls":"stun:bad host"}]'},
            {'PEOPLE_ICE_SERVERS':'[{"urls":"stun:ok.invalid","username":1}]'},
            {'PEOPLE_ICE_SERVERS':'[{"urls":"stun:ok.invalid","unexpected":true}]'},
            {'PEOPLE_TURN_URLS':'["turn:relay.invalid"]', 'PEOPLE_TURN_SECRET':'short'},
            {'PEOPLE_TURN_URLS':'["https://relay.invalid"]', 'PEOPLE_TURN_SECRET':'s'*32},
        ]
        for values in examples:
            env = {'PEOPLE_ICE_SERVERS':'[]', 'PEOPLE_TURN_URLS':'[]', 'PEOPLE_TURN_SECRET':''} | values
            with self.subTest(values=values), patch.dict(os.environ, env), self.assertRaises(ValueError):
                calls.ice_servers('alice')
