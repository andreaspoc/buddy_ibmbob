"""Deep unit tests for buddy_people.community_calls.

Hermetic tests: no real network, third-party APIs, or live telemetry.
All database sessions, environment variables, and WebSocket interactions are mocked.
"""
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, Mock, patch
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[1]
PLUGINS_LEARNING = ROOT / 'plugins' / 'learning'
PLUGINS_PEOPLE = ROOT / 'plugins' / 'people'

for p in (str(ROOT), str(PLUGINS_LEARNING), str(PLUGINS_PEOPLE)):
    if p not in sys.path:
        sys.path.insert(0, p)

from fastapi import HTTPException, WebSocketDisconnect
from pydantic import ValidationError

from buddy_people import community_calls as calls
from buddy_people.community_calls import Connectivity, Signal


class Cursor:
    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = rows if rows is not None else ([row] if row is not None else [])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class DBContext:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, *args):
        pass


class MockDB:
    def __init__(self):
        self.queries = []
        self.handlers = []

    def add_handler(self, matcher, result):
        self.handlers.append((matcher, result))

    def execute(self, sql, params=()):
        compact = ' '.join(sql.split())
        self.queries.append((compact, params))
        for matcher, result in self.handlers:
            matched = matcher(compact, params) if callable(matcher) else matcher in compact
            if matched:
                if callable(result):
                    res = result(compact, params)
                else:
                    res = result
                if isinstance(res, Cursor):
                    return res
                if isinstance(res, list):
                    return Cursor(rows=res)
                return Cursor(row=res)
        return Cursor(row=None, rows=[])


# ==============================================================================
# Model and Validation Deep Tests
# ==============================================================================
class PeopleCallsModelTests(unittest.TestCase):
    def test_connectivity_model_validations(self):
        # 1. Valid connectivity
        valid_data = {
            'connection_state': 'connected',
            'ice_state': 'completed',
            'gathering_state': 'complete',
            'local_candidate_types': ['host', 'srflx'],
            'ice_error_codes': [701]
        }
        conn = Connectivity.model_validate(valid_data)
        self.assertEqual(conn.connection_state, 'connected')

        # 2. Extra fields forbidden
        with self.assertRaises(ValidationError):
            Connectivity.model_validate({**valid_data, 'extra_telemetry': 123})

        # 3. Invalid state enum
        with self.assertRaises(ValidationError):
            Connectivity.model_validate({**valid_data, 'connection_state': 'unknown'})

        # 4. Local candidate types > 4
        with self.assertRaises(ValidationError):
            Connectivity.model_validate({**valid_data, 'local_candidate_types': ['host', 'srflx', 'prflx', 'relay', 'host']})

        # 5. ICE error code out of range [100, 999]
        with self.assertRaises(ValidationError):
            Connectivity.model_validate({**valid_data, 'ice_error_codes': [99]})
        with self.assertRaises(ValidationError):
            Connectivity.model_validate({**valid_data, 'ice_error_codes': [1000]})

    def test_signal_model_actions_and_bounds(self):
        cid = uuid4()
        sdp_audio = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9000 RTP/SAVPF 111\r\n"

        # 1. Action 'ping'
        sig_ping = Signal.model_validate({'action': 'ping'})
        self.assertEqual(sig_ping.action, 'ping')
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'ping', 'room_id': 1})

        # 2. Action 'start'
        sig_start = Signal.model_validate({'action': 'start', 'room_id': 100})
        self.assertEqual(sig_start.room_id, 100)
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'start'})  # Missing room_id
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'start', 'room_id': 100, 'call_id': cid})  # Extra call_id

        # 3. Action 'accept' and 'decline'
        sig_accept = Signal.model_validate({'action': 'accept', 'call_id': cid})
        self.assertEqual(sig_accept.call_id, cid)
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'accept'})  # Missing call_id
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'decline', 'call_id': cid, 'room_id': 1})  # Extra room_id

        # 4. Action 'end'
        sig_end = Signal.model_validate({'action': 'end', 'call_id': cid, 'reason': 'hangup'})
        self.assertEqual(sig_end.reason, 'hangup')
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'end', 'call_id': cid, 'reason': 'invalid_reason'})

        # 5. Action 'offer' and 'answer' with SDP validations
        sig_offer = Signal.model_validate({'action': 'offer', 'call_id': cid, 'sdp': sdp_audio})
        self.assertIn("m=audio", sig_offer.sdp)

        # SDP must start with v=0
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'offer', 'call_id': cid, 'sdp': 'invalid sdp'})

        # SDP without audio
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'offer', 'call_id': cid, 'sdp': 'v=0\r\nm=data 9000 RTP\r\n'})

        # SDP with video rejected
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'offer', 'call_id': cid, 'sdp': sdp_audio + '\nm=video 9002 RTP\r\n'})

        # SDP with application rejected
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'answer', 'call_id': cid, 'sdp': sdp_audio + '\nm=application 9004 RTP\r\n'})

        # 6. Action 'ice' validations
        valid_cand = {'candidate': 'candidate:1 1 UDP 2122260223 192.168.1.1 5000 typ host', 'sdpMid': '0', 'sdpMLineIndex': 0}
        sig_ice = Signal.model_validate({'action': 'ice', 'call_id': cid, 'candidate': valid_cand})
        self.assertEqual(sig_ice.candidate['sdpMid'], '0')

        # Invalid candidate: not dict
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'ice', 'call_id': cid, 'candidate': 'invalid'})

        # Invalid candidate: unexpected key
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'ice', 'call_id': cid, 'candidate': {**valid_cand, 'fake_metric': 1}})

        # Invalid candidate: string too long > 1800
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'ice', 'call_id': cid, 'candidate': {'candidate': 'x' * 1801}})

        # Invalid candidate: sdpMid too long > 32
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'ice', 'call_id': cid, 'candidate': {'candidate': 'cand', 'sdpMid': 'x' * 33}})

        # Invalid candidate: sdpMLineIndex > 8
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'ice', 'call_id': cid, 'candidate': {'candidate': 'cand', 'sdpMLineIndex': 9}})

        # Invalid candidate: usernameFragment > 256
        with self.assertRaises(ValidationError):
            Signal.model_validate({'action': 'ice', 'call_id': cid, 'candidate': {'candidate': 'cand', 'usernameFragment': 'u' * 257}})


# ==============================================================================
# ICE Servers Configuration Deep Tests
# ==============================================================================
class IceServersTests(unittest.TestCase):
    def test_ice_servers_parsing(self):
        # 1. Invalid JSON in PEOPLE_ICE_SERVERS
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': 'invalid json'}):
            with self.assertRaises(ValueError):
                calls.ice_servers()

        # 2. Not a list
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': '{"url": "stun:stun.example.com"}'}):
            with self.assertRaises(ValueError) as ctx:
                calls.ice_servers()
            self.assertIn("Invalid voice ICE configuration", str(ctx.exception))

        # 3. List length > 8
        huge_servers = json.dumps([{'urls': 'stun:stun.example.com'} for _ in range(9)])
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': huge_servers}):
            with self.assertRaises(ValueError):
                calls.ice_servers()

        # Extra key in server item
        extra_key_server = json.dumps([{'urls': 'stun:stun.example.com', 'unknown_field': 'val'}])
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': extra_key_server}):
            with self.assertRaises(ValueError) as ctx:
                calls.ice_servers()
            self.assertIn("Invalid voice ICE server", str(ctx.exception))

        # 4. Invalid URL scheme (http:// instead of stun:/turn:)
        bad_scheme = json.dumps([{'urls': 'http://stun.example.com'}])
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': bad_scheme}):
            with self.assertRaises(ValueError) as ctx:
                calls.ice_servers()
            self.assertIn("Invalid voice ICE URL", str(ctx.exception))

        # 5. URL with spaces
        space_url = json.dumps([{'urls': 'stun:stun .example.com'}])
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': space_url}):
            with self.assertRaises(ValueError):
                calls.ice_servers()

        # 6. Credentials too long > 2000
        long_cred = json.dumps([{'urls': 'stun:stun.example.com', 'username': 'x' * 2001}])
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': long_cred}):
            with self.assertRaises(ValueError) as ctx:
                calls.ice_servers()
            self.assertIn("Invalid voice ICE credentials", str(ctx.exception))

        # 7. Valid STUN list
        valid_stun = json.dumps([{'urls': ['stun:stun.example.com:3478']}])
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': valid_stun, 'PEOPLE_TURN_URLS': '[]'}):
            res = calls.ice_servers('user1')
            self.assertEqual(len(res), 1)
            self.assertEqual(res[0]['urls'], ['stun:stun.example.com:3478'])

    def test_turn_urls_and_hmac_generation(self):
        turn_urls = json.dumps(['turn:turn.example.com:3478'])
        secret = '0123456789abcdef0123456789abcdef'  # 32 chars

        # 1. Missing username with TURN configured
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': '[]', 'PEOPLE_TURN_URLS': turn_urls, 'PEOPLE_TURN_SECRET': secret}):
            with self.assertRaises(ValueError) as ctx:
                calls.ice_servers(username=None)
            self.assertIn("Authenticated voice relay is not configured correctly", str(ctx.exception))

        # 2. Secret < 32 chars
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': '[]', 'PEOPLE_TURN_URLS': turn_urls, 'PEOPLE_TURN_SECRET': 'short_secret'}):
            with self.assertRaises(ValueError):
                calls.ice_servers(username='test_user')

        # 3. Bad turn scheme
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': '[]', 'PEOPLE_TURN_URLS': json.dumps(['stun:not-a-turn.com']), 'PEOPLE_TURN_SECRET': secret}):
            with self.assertRaises(ValueError):
                calls.ice_servers(username='test_user')

        # 4. Valid TURN configuration generates HMAC password
        with patch.dict(os.environ, {'PEOPLE_ICE_SERVERS': '[]', 'PEOPLE_TURN_URLS': turn_urls, 'PEOPLE_TURN_SECRET': secret}):
            res = calls.ice_servers(username='alice')
            self.assertEqual(len(res), 1)
            turn_entry = res[0]
            self.assertEqual(turn_entry['urls'], ['turn:turn.example.com:3478'])
            self.assertTrue(':' in turn_entry['username'])
            # Verify base64 decoded password is a 20-byte sha1 digest
            decoded = base64.b64decode(turn_entry['credential'])
            self.assertEqual(len(decoded), 20)


# ==============================================================================
# Database Lifecycle & Helper Deep Tests
# ==============================================================================
class PeopleCallsDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.cid = uuid4()
        self.rid = 101
        self.client_a = uuid4()
        self.client_b = uuid4()
        self.now = datetime.now(timezone.utc)

    def test_schema_execution(self):
        db = MockDB()
        # Mock fetchall for missed calls restoration
        missed_row = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice',
            'callee': 'bob', 'status': 'ended', 'reason': 'timeout',
            'ended_at': self.now, 'accepted_at': None
        }
        db.add_handler("SELECT * FROM people_chat.bob_voice_calls c", [missed_row])
        with patch('buddy_people.community_calls.record_missed_call') as mock_missed:
            calls.schema(db)
            mock_missed.assert_called_once_with(db, missed_row)
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS people_chat.bob_voice_calls' in q[0] for q in db.queries))
        self.assertTrue(any('ALTER TABLE people_chat.bob_chat_messages ADD COLUMN' in q[0] for q in db.queries))

    def test_notify(self):
        db = MockDB()
        calls.notify(db, self.cid)
        self.assertTrue(any('SELECT pg_notify(%s,%s)' in q[0] for q in db.queries))
        call_id_param = db.queries[-1][1][1]
        self.assertIn(str(self.cid), call_id_param)

    def test_record_missed_call(self):
        db = MockDB()
        # 1. Accepted call -> not recorded
        row_accepted = {'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'ended_at': self.now, 'accepted_at': self.now, 'reason': 'hangup'}
        calls.record_missed_call(db, row_accepted)
        self.assertEqual(len(db.queries), 0)

        # 2. Reason not in missed set -> not recorded
        row_other_reason = {'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'ended_at': self.now, 'accepted_at': None, 'reason': 'declined'}
        calls.record_missed_call(db, row_other_reason)
        self.assertEqual(len(db.queries), 0)

        # 3. Valid missed call -> inserts message and calls changed()
        row_missed = {'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'ended_at': self.now, 'accepted_at': None, 'reason': 'timeout'}
        db.add_handler("INSERT INTO people_chat.bob_chat_messages", {'id': 999})
        with patch('buddy_people.community.changed') as mock_changed:
            calls.record_missed_call(db, row_missed)
            self.assertTrue(any('INSERT INTO people_chat.bob_chat_messages' in q[0] for q in db.queries))
            mock_changed.assert_called_once_with(db, self.rid, 999)

    def test_end_and_expire(self):
        db = MockDB()
        row = {'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob', 'status': 'ringing'}

        # end() updates status, calls record_missed_call and notify
        ended_row = {**row, 'status': 'ended', 'reason': 'hangup', 'accepted_at': None, 'ended_at': self.now}
        db.add_handler("UPDATE people_chat.bob_voice_calls SET status='ended'", ended_row)
        with patch('buddy_people.community_calls.record_missed_call') as mock_missed, \
             patch('buddy_people.community_calls.notify') as mock_notify:
            calls.end(db, row, 'hangup')
            mock_missed.assert_called_once_with(db, ended_row)
            mock_notify.assert_called_once_with(db, self.cid)

        # expire() finds expired calls and ends them
        db_exp = MockDB()
        db_exp.add_handler("UPDATE people_chat.bob_voice_calls SET status='ended',reason='timeout'", [ended_row])
        with patch('buddy_people.community_calls.record_missed_call') as mock_missed, \
             patch('buddy_people.community_calls.notify') as mock_notify:
            calls.expire(db_exp, 'alice')
            mock_missed.assert_called_once_with(db_exp, ended_row)
            mock_notify.assert_called_once_with(db_exp, self.cid)

    def test_read_call(self):
        db = MockDB()
        # 1. Call not found -> 404
        with self.assertRaises(HTTPException) as ctx:
            calls.read_call(db, self.cid, 'alice')
        self.assertEqual(ctx.exception.status_code, 404)

        # 2. Memberships revoked (< 2) -> call ended with access_removed
        row = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': self.client_b,
            'status': 'active', 'reason': None
        }
        db.add_handler("SELECT * FROM people_chat.bob_voice_calls", row)
        db.add_handler("SELECT username FROM people_chat.bob_chat_members", [{'username': 'alice'}])  # only 1 member
        with patch('buddy_people.community_calls.end') as mock_end:
            result = calls.read_call(db, self.cid, 'alice')
            self.assertEqual(result['status'], 'ended')
            self.assertEqual(result['reason'], 'access_removed')
            mock_end.assert_called_once_with(db, row, 'access_removed')

    def test_public_call(self):
        db = MockDB()
        row = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': self.client_b,
            'status': 'ringing', 'reason': None, 'created_at': self.now,
            'transport': 'webrtc', 'accepted_at': None
        }
        db.add_handler("SELECT u.username,", [
            {'username': 'alice', 'name': 'Alice Human'},
            {'username': 'bob', 'name': 'Bob Human'}
        ])
        # Caller perspective, owned
        pub_caller = calls.public_call(db, row, 'alice', self.client_a)
        self.assertEqual(pub_caller['call']['role'], 'caller')
        self.assertTrue(pub_caller['call']['owned'])
        self.assertEqual(pub_caller['call']['caller_name'], 'Alice Human')
        self.assertIsNone(pub_caller['call']['accepted_at'])

        # Callee perspective, other tab (not owned)
        pub_callee = calls.public_call(db, row, 'bob', uuid4())
        self.assertEqual(pub_callee['call']['role'], 'callee')
        self.assertFalse(pub_callee['call']['owned'])

    def test_state_and_heartbeat_and_disconnect(self):
        db = MockDB()
        row = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': self.client_b,
            'status': 'active', 'reason': None, 'created_at': self.now,
            'transport': 'webrtc', 'accepted_at': self.now
        }
        db.add_handler("SELECT * FROM people_chat.bob_voice_calls", row)
        db.add_handler("SELECT username FROM people_chat.bob_chat_members", [{'username': 'alice'}, {'username': 'bob'}])
        db.add_handler("SELECT u.username,", [{'username': 'alice', 'name': 'Alice'}, {'username': 'bob', 'name': 'Bob'}])

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)):
            # state()
            st = calls.state('alice', self.client_a, self.cid)
            self.assertEqual(st['call']['id'], str(self.cid))

            # heartbeat()
            db.add_handler("SELECT id FROM people_chat.bob_voice_calls", [{'id': self.cid}])
            hb = calls.heartbeat('alice', self.client_a)
            self.assertEqual(len(hb), 1)

            # disconnect()
            db_disc = MockDB()
            db_disc.add_handler("SELECT * FROM people_chat.bob_voice_calls", [row])
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_disc)), \
                 patch('buddy_people.community_calls.end') as mock_end:
                calls.disconnect('alice', self.client_a)
                mock_end.assert_called_once()


# ==============================================================================
# Signaling Workflow Deep Tests
# ==============================================================================
class PeopleCallsHandleTests(unittest.TestCase):
    def setUp(self):
        self.cid = uuid4()
        self.rid = 202
        self.client_a = uuid4()
        self.client_b = uuid4()
        self.now = datetime.now(timezone.utc)
        self.sdp = "v=0\r\nm=audio 9000 RTP/SAVPF 111\r\n"

    def test_handle_start_branches(self):
        # 1. Room is not direct -> 422
        db = MockDB()
        db.add_handler("SELECT kind FROM people_chat.bob_chat_rooms", {'kind': 'group'})
        db.add_handler("SELECT username FROM people_chat.bob_chat_members", [{'username': 'bob'}])
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community.member'):
            with self.assertRaises(HTTPException) as ctx:
                calls.handle('alice', self.client_a, Signal(action='start', room_id=self.rid))
            self.assertEqual(ctx.exception.status_code, 422)

        # 2. Already in active call -> 409
        db_busy = MockDB()
        db_busy.add_handler("SELECT kind FROM people_chat.bob_chat_rooms", {'kind': 'direct'})
        db_busy.add_handler("SELECT username FROM people_chat.bob_chat_members", [{'username': 'bob'}])
        db_busy.add_handler("SELECT 1 FROM people_chat.bob_voice_calls WHERE status<>'ended'", {'found': 1})
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_busy)), \
             patch('buddy_people.community.member'):
            with self.assertRaises(HTTPException) as ctx:
                calls.handle('alice', self.client_a, Signal(action='start', room_id=self.rid))
            self.assertEqual(ctx.exception.status_code, 409)

        # 3. Successful start
        db_start = MockDB()
        row_created = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': None, 'status': 'ringing',
            'transport': 'webrtc', 'reason': None, 'created_at': self.now, 'accepted_at': None
        }
        db_start.add_handler("SELECT kind FROM people_chat.bob_chat_rooms", {'kind': 'direct'})
        db_start.add_handler("SELECT username FROM people_chat.bob_chat_members WHERE room_id=", [{'username': 'bob'}])
        db_start.add_handler("SELECT 1 FROM people_chat.bob_voice_calls WHERE status<>'ended'", None)
        db_start.add_handler("INSERT INTO people_chat.bob_voice_calls", row_created)
        db_start.add_handler("SELECT u.username,", [{'username': 'alice', 'name': 'Alice'}, {'username': 'bob', 'name': 'Bob'}])
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_start)), \
             patch('buddy_people.community.member'), \
             patch('buddy_people.community_call_audio.transport', return_value='webrtc'):
            res = calls.handle('alice', self.client_a, Signal(action='start', room_id=self.rid))
            self.assertEqual(res['call']['status'], 'ringing')
            self.assertEqual(res['call']['caller'], 'alice')

    def test_handle_accept_and_decline(self):
        row_ringing = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': None, 'status': 'ringing',
            'transport': 'webrtc', 'reason': None, 'created_at': self.now, 'accepted_at': None
        }

        # 1. Caller trying to accept -> 409
        db = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community_calls.read_call', return_value=row_ringing):
            with self.assertRaises(HTTPException) as ctx:
                calls.handle('alice', self.client_a, Signal(action='accept', call_id=self.cid))
            self.assertEqual(ctx.exception.status_code, 409)

        # 2. Decline call
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community_calls.read_call', return_value=row_ringing), \
             patch('buddy_people.community_calls.end') as mock_end, \
             patch('buddy_people.community_calls.public_call', return_value={'type': 'call_state'}):
            calls.handle('bob', self.client_b, Signal(action='decline', call_id=self.cid))
            mock_end.assert_called_once_with(db, row_ringing, 'declined')

        # 3. Accept call
        db_accept = MockDB()
        db_accept.add_handler("UPDATE people_chat.bob_voice_calls SET status='accepted'", {})
        db_accept.add_handler("SELECT * FROM people_chat.bob_voice_calls", {**row_ringing, 'status': 'accepted', 'accepted_at': self.now})
        db_accept.add_handler("SELECT u.username,", [{'username': 'alice', 'name': 'Alice'}, {'username': 'bob', 'name': 'Bob'}])
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_accept)), \
             patch('buddy_people.community_calls.read_call', return_value=row_ringing), \
             patch('buddy_people.community_calls.notify') as mock_notify:
            res = calls.handle('bob', self.client_b, Signal(action='accept', call_id=self.cid))
            self.assertEqual(res['call']['status'], 'accepted')
            mock_notify.assert_called_once_with(db_accept, self.cid)

    def test_handle_end_and_diagnostics(self):
        row = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': self.client_b,
            'status': 'accepted', 'transport': 'webrtc', 'reason': None,
            'created_at': self.now, 'accepted_at': self.now
        }

        # 1. Wrong tab (not owned) -> 403
        db = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community_calls.read_call', return_value=row):
            with self.assertRaises(HTTPException) as ctx:
                calls.handle('alice', uuid4(), Signal(action='end', call_id=self.cid))
            self.assertEqual(ctx.exception.status_code, 403)

        # 2. End with diagnostics
        diag = Connectivity(
            connection_state='failed', ice_state='failed', gathering_state='complete',
            local_candidate_types=['host'], ice_error_codes=[701]
        )
        db_diag = MockDB()
        db_diag.add_handler("SELECT * FROM people_chat.bob_voice_calls", {**row, 'status': 'ended', 'reason': 'connection_failed'})
        db_diag.add_handler("SELECT u.username,", [{'username': 'alice', 'name': 'Alice'}, {'username': 'bob', 'name': 'Bob'}])
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_diag)), \
             patch('buddy_people.community_calls.read_call', return_value=row), \
             patch('buddy_people.community_calls.end') as mock_end:
            calls.handle('alice', self.client_a, Signal(action='end', call_id=self.cid, diagnostics=diag, reason='connection_failed'))
            self.assertTrue(any('UPDATE people_chat.bob_voice_calls SET diagnostics=' in q[0] for q in db_diag.queries))
            mock_end.assert_called_once()

    def test_handle_connected(self):
        row_ringing = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': None,
            'status': 'ringing', 'transport': 'webrtc', 'reason': None,
            'created_at': self.now, 'accepted_at': None
        }
        db = MockDB()
        # Connect while ringing -> 409
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community_calls.read_call', return_value=row_ringing):
            with self.assertRaises(HTTPException) as ctx:
                calls.handle('alice', self.client_a, Signal(action='connected', call_id=self.cid))
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertIn("Accept the call before connecting audio", ctx.exception.detail)

        row = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': self.client_b,
            'status': 'accepted', 'transport': 'webrtc', 'reason': None,
            'created_at': self.now, 'accepted_at': self.now
        }
        db_conn = MockDB()
        db_conn.add_handler("SELECT * FROM people_chat.bob_voice_calls", {**row, 'status': 'active'})
        db_conn.add_handler("SELECT u.username,", [{'username': 'alice', 'name': 'Alice'}, {'username': 'bob', 'name': 'Bob'}])
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_conn)), \
             patch('buddy_people.community_calls.read_call', return_value=row), \
             patch('buddy_people.community_calls.notify') as mock_notify:
            res = calls.handle('alice', self.client_a, Signal(action='connected', call_id=self.cid))
            self.assertTrue(any('caller_connected=true' in q[0] for q in db_conn.queries))
            mock_notify.assert_called_once()

    def test_handle_offer_answer_and_role_restrictions(self):
        row = {
            'id': self.cid, 'room_id': self.rid, 'caller': 'alice', 'callee': 'bob',
            'caller_client': self.client_a, 'callee_client': self.client_b,
            'status': 'accepted', 'transport': 'webrtc', 'reason': None,
            'created_at': self.now, 'accepted_at': self.now
        }
        db = MockDB()

        # 1. Offer by callee -> 403
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community_calls.read_call', return_value=row):
            with self.assertRaises(HTTPException) as ctx:
                calls.handle('bob', self.client_b, Signal(action='offer', call_id=self.cid, sdp=self.sdp))
            self.assertEqual(ctx.exception.status_code, 403)

        # 2. Answer by caller -> 403
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community_calls.read_call', return_value=row):
            with self.assertRaises(HTTPException) as ctx:
                calls.handle('alice', self.client_a, Signal(action='answer', call_id=self.cid, sdp=self.sdp))
            self.assertEqual(ctx.exception.status_code, 403)

        # 3. Valid offer by caller -> sends pg_notify
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_people.community_calls.read_call', return_value=row):
            res = calls.handle('alice', self.client_a, Signal(action='offer', call_id=self.cid, sdp=self.sdp))
            self.assertIsNone(res)
            self.assertTrue(any('SELECT pg_notify(%s,%s)' in q[0] for q in db.queries))


# ==============================================================================
# WebSocket Endpoint Security Deep Tests
# ==============================================================================
class PeopleCallsWebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_origin_security_and_auth(self):
        handlers = []
        fake_router = SimpleNamespace(websocket=lambda path: lambda f: handlers.append(f) or f)
        mock_auth = AsyncMock()

        # Register endpoint
        calls.register(fake_router, mock_auth)
        self.assertEqual(len(handlers), 1)
        ws_handler = handlers[0]

        # 1. Missing origin -> closed with code 1008
        socket_no_origin = SimpleNamespace(
            headers={'host': 'example.com'},
            close=AsyncMock()
        )
        await ws_handler(socket_no_origin)
        socket_no_origin.close.assert_awaited_once_with(code=1008)

        # 2. Host mismatch -> closed with code 1008
        socket_bad_host = SimpleNamespace(
            headers={'origin': 'http://evil.com', 'host': 'example.com'},
            close=AsyncMock()
        )
        await ws_handler(socket_bad_host)
        socket_bad_host.close.assert_awaited_once_with(code=1008)

        # 3. Auth failure -> closed with code 1008
        socket_auth_fail = SimpleNamespace(
            headers={'origin': 'http://example.com', 'host': 'example.com'},
            close=AsyncMock()
        )
        mock_auth.side_effect = HTTPException(401, 'Unauthorized')
        await ws_handler(socket_auth_fail)
        socket_auth_fail.close.assert_awaited_once_with(code=1008)


if __name__ == '__main__':
    unittest.main()
