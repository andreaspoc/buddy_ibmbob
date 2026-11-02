"""Disposable database checks for encrypted same-origin audio ownership."""
import secrets,unittest,os
from uuid import uuid4
from unittest.mock import patch
from fastapi import HTTPException
from pydantic import ValidationError
from app import auth,job_queue
from buddy_people import community as c,community_calls as calls,community_call_audio as audio
KEY={'kty':'EC','crv':'P-256','x':'A'*43,'y':'B'*43} # Synthetic schema fixture, never used for cryptography.
class AudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env=patch.dict(os.environ,{'PEOPLE_AUDIO_TRANSPORT':'websocket'});cls.env.start();c.ensure_schema()
        cls.users=[auth.create_user('audio-test-'+uuid4().hex[:12],secrets.token_urlsafe(24)) for _ in range(3)]
        cls.room=c.create_room(c.RoomCreate(kind='direct',peer=cls.users[1]['username']),user=cls.users[0])['id']
    @classmethod
    def tearDownClass(cls):
        with job_queue._connect() as db:
            db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE id=%s',(cls.room,))
            for user in cls.users:
                db.execute('DELETE FROM bob_user_profiles WHERE username=%s',(user['username'],));db.execute('DELETE FROM users WHERE username=%s',(user['username'],))
        cls.env.stop()
    def setUp(self):
        self.a,self.b,self.out=[u['username'] for u in self.users];self.ca,self.cb=uuid4(),uuid4()
        with job_queue._connect() as db:db.execute('DELETE FROM people_chat.bob_voice_calls WHERE room_id=%s',(self.room,))
        self.call=calls.handle(self.a,self.ca,calls.Signal(action='start',room_id=self.room))['call']['id']
    def test_no_audio_before_acceptance_or_without_owned_connection(self):
        with self.assertRaises(HTTPException):audio.attach(self.a,self.ca,self.call,uuid4(),KEY)
        calls.handle(self.b,self.cb,calls.Signal(action='accept',call_id=self.call))
        with self.assertRaises(HTTPException):audio.attach(self.out,uuid4(),self.call,uuid4(),KEY)
        with self.assertRaises(HTTPException):audio.attach(self.a,uuid4(),self.call,uuid4(),KEY)
        self.assertEqual(calls.state(self.a,self.ca,self.call)['call']['transport'],'websocket')
    def test_public_key_exchange_and_disconnect_are_scoped(self):
        calls.handle(self.b,self.cb,calls.Signal(action='accept',call_id=self.call))
        aa,ab=uuid4(),uuid4()
        self.assertEqual(audio.attach(self.a,self.ca,self.call,aa,KEY),'caller')
        self.assertIsNone(audio.peer_key(self.a,self.ca,self.call,aa))
        with self.assertRaises(HTTPException):audio.attach(self.a,self.ca,self.call,uuid4(),KEY)
        audio.attach(self.b,self.cb,self.call,ab,KEY)
        self.assertEqual(audio.peer_key(self.a,self.ca,self.call,aa),KEY)
        audio.detach(self.a,self.ca,self.call,aa)
        self.assertEqual(calls.state(self.b,self.cb,self.call)['call']['status'],'ended')
    def test_hello_cannot_supply_private_key_or_identity(self):
        for value in [{'client_id':uuid4(),'public_key':{**KEY,'d':'private'}},{'client_id':uuid4(),'public_key':KEY,'username':self.out}]:
            with self.assertRaises(ValidationError):audio.AudioHello.model_validate(value)
    def test_ciphertext_and_pcm_are_not_database_columns(self):
        with job_queue._connect() as db:columns={r['column_name'] for r in db.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='people_chat' AND table_name='bob_voice_calls'").fetchall()}
        self.assertFalse(columns.intersection({'pcm','audio_data','ciphertext','audio_frames','private_key'}))
if __name__=='__main__':unittest.main()
