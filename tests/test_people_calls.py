"""Database integration with disposable synthetic members and no real audio/users."""
import json
import os
import secrets
import unittest
from unittest.mock import patch
from uuid import uuid4
from fastapi import HTTPException
from pydantic import ValidationError
from app import auth, job_queue, notification_inbox
from buddy_people import community as c, community_calls as calls

SDP='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'

class PeopleCallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.transport_env=patch.dict(os.environ,{'PEOPLE_AUDIO_TRANSPORT':'webrtc'});cls.transport_env.start()
        notification_inbox.ensure_schema(); c.ensure_schema();cls.users=[auth.create_user('voice-test-'+uuid4().hex[:12],secrets.token_urlsafe(24)) for _ in range(3)]
        cls.room=c.create_room(c.RoomCreate(kind='direct',peer=cls.users[1]['username']),user=cls.users[0])['id']
    @classmethod
    def tearDownClass(cls):
        with job_queue._connect() as db:
            db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE id=%s',(cls.room,))
            for u in cls.users:
                db.execute('DELETE FROM bob_user_profiles WHERE username=%s',(u['username'],));db.execute('DELETE FROM users WHERE username=%s',(u['username'],))
        cls.transport_env.stop()
    def setUp(self):
        self.a,self.b,self.out=[u['username'] for u in self.users];self.ca,self.cb=uuid4(),uuid4()
        with job_queue._connect() as db:
            db.execute('DELETE FROM people_chat.bob_voice_calls WHERE room_id=%s',(self.room,))
            db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES(%s,%s) ON CONFLICT DO NOTHING',(self.room,self.b))
    def signal(self,user,client,action,**args):return calls.handle(user,client,calls.Signal(action=action,**args))
    def start(self):return self.signal(self.a,self.ca,'start',room_id=self.room)['call']['id']
    def test_missed_call_is_saved_once_in_conversation(self):
        call_id = self.start()
        self.signal(self.a, self.ca, 'end', call_id=call_id, reason='hangup')
        self.signal(self.a, self.ca, 'end', call_id=call_id, reason='hangup')
        with job_queue._connect() as db:
            rows = db.execute('SELECT body,sender FROM people_chat.bob_chat_messages WHERE voice_call_id=%s', (call_id,)).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['body'], 'Missed voice call')
        self.assertEqual(rows[0]['sender'], self.a)
        from app.notification_inbox import missed_call_notifications
        with job_queue._connect() as db:
            notices = missed_call_notifications(db, self.b)
            self.assertTrue(any(item['id'] == 'missed-call:' + call_id for item in notices))
            self.assertFalse(any(item['id'] == 'missed-call:' + call_id for item in missed_call_notifications(db, self.a)))
        history = c.messages(self.room, __import__('fastapi').Response(), after=0, user=self.users[1])
        self.assertTrue(any(str(message.get('voice_call_id')) == call_id for message in history))
        rooms = c.rooms(__import__('fastapi').Response(), user=self.users[1])
        room = next(item for item in rooms if item['id'] == self.room)
        self.assertIsNone(room['notification_incoming_id'], 'Call history must not also create a message popup')

    def test_signal_schema_limits_identity_media_and_size(self):
        for payload in [{'action':'start','room_id':self.room,'username':self.out},{'action':'offer','call_id':uuid4(),'sdp':SDP+'m=video 9 UDP/TLS/RTP/SAVPF 96\r\n'},{'action':'ice','call_id':uuid4(),'candidate':{'candidate':'x','target':self.out}},{'action':'offer','call_id':uuid4(),'sdp':'x'*6001}]:
            with self.subTest(payload=payload),self.assertRaises(ValidationError):calls.Signal.model_validate(payload)
    def test_accept_consent_roles_and_multi_tab_ownership(self):
        call_id=self.start()
        with self.assertRaises(HTTPException):self.signal(self.a,self.ca,'offer',call_id=call_id,sdp=SDP)
        with self.assertRaises(HTTPException):self.signal(self.a,self.ca,'accept',call_id=call_id)
        accepted=self.signal(self.b,self.cb,'accept',call_id=call_id)
        self.assertEqual(accepted['call']['status'],'accepted');self.assertTrue(accepted['call']['owned'])
        with self.assertRaises(HTTPException):self.signal(self.b,uuid4(),'accept',call_id=call_id)
        with self.assertRaises(HTTPException):self.signal(self.a,uuid4(),'end',call_id=call_id)
        with self.assertRaises(HTTPException):self.signal(self.b,self.cb,'offer',call_id=call_id,sdp=SDP)
        self.assertIsNone(self.signal(self.a,self.ca,'offer',call_id=call_id,sdp=SDP))
    def test_nonmembers_and_simultaneous_calls_rejected(self):
        with self.assertRaises(HTTPException):self.signal(self.out,uuid4(),'start',room_id=self.room)
        call_id=self.start()
        with self.assertRaises(HTTPException):self.signal(self.out,uuid4(),'accept',call_id=call_id)
        with self.assertRaises(HTTPException):self.signal(self.b,self.cb,'start',room_id=self.room)
    def test_actual_connected_state_requires_both_peers_and_disconnect_ends(self):
        call_id=self.start();self.signal(self.b,self.cb,'accept',call_id=call_id)
        self.assertEqual(self.signal(self.a,self.ca,'connected',call_id=call_id)['call']['status'],'accepted')
        self.assertEqual(self.signal(self.b,self.cb,'connected',call_id=call_id)['call']['status'],'active')
        calls.disconnect(self.a,self.ca)
        terminal=calls.state(self.b,self.cb,call_id)['call']
        self.assertEqual(terminal['status'],'ended');self.assertEqual(terminal['reason'],'disconnected')
    def test_membership_revocation_stops_signaling_and_reports_terminal(self):
        call_id=self.start();self.signal(self.b,self.cb,'accept',call_id=call_id)
        with job_queue._connect() as db:db.execute('DELETE FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s',(self.room,self.b))
        terminal=calls.state(self.a,self.ca,call_id)['call']
        self.assertEqual(terminal['status'],'ended');self.assertEqual(terminal['reason'],'access_removed')
    def test_expired_invites_and_ice_config(self):
        call_id=self.start()
        with job_queue._connect() as db:db.execute("UPDATE people_chat.bob_voice_calls SET created_at=now()-interval '50 seconds' WHERE id=%s",(call_id,))
        calls.heartbeat(self.a,self.ca)
        self.assertEqual(calls.state(self.a,self.ca,call_id)['call']['reason'],'timeout')
        with patch.dict(os.environ,{'PEOPLE_TURN_URLS':'[]','PEOPLE_ICE_SERVERS':json.dumps([{'urls':['turn:relay.example.invalid:3478'],'username':'synthetic','credential':'synthetic'}])}):self.assertEqual(len(calls.ice_servers()),1)
        with patch.dict(os.environ,{'PEOPLE_TURN_URLS':'[]','PEOPLE_ICE_SERVERS':'[{"urls":"https://example.invalid"}]'}):
            with self.assertRaises(ValueError):calls.ice_servers()
    def test_automatic_incoming_end_is_not_a_decline(self):
        call_id=self.start()
        initial=calls.state(self.b,self.cb,call_id)['call']
        self.assertGreater(initial['ring_remaining_ms'],40000)
        terminal=self.signal(self.b,self.cb,'end',call_id=call_id,reason='timeout')['call']
        self.assertEqual(terminal['reason'],'timeout');self.assertNotEqual(terminal['reason'],'declined')

    def test_connection_diagnostics_are_owner_scoped_and_content_free(self):
        call_id=self.start();self.signal(self.b,self.cb,'accept',call_id=call_id)
        facts={'connection_state':'failed','ice_state':'failed','gathering_state':'complete','local_candidate_types':['host'],'ice_error_codes':[701]}
        with self.assertRaises(ValidationError):calls.Signal(action='end',call_id=call_id,diagnostics={**facts,'sdp':'private content'})
        self.signal(self.a,self.ca,'end',call_id=call_id,reason='connection_failed',diagnostics=facts)
        with job_queue._connect() as db:row=db.execute('SELECT diagnostics FROM people_chat.bob_voice_calls WHERE id=%s',(call_id,)).fetchone()
        self.assertEqual(row['diagnostics'],{'caller':facts})

    def test_sdp_and_ice_not_persisted(self):
        with job_queue._connect() as db:
            names=[r['column_name'] for r in db.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='people_chat' AND table_name='bob_voice_calls'").fetchall()]
        self.assertNotIn('sdp',names);self.assertNotIn('candidate',names)

if __name__=='__main__':unittest.main()
