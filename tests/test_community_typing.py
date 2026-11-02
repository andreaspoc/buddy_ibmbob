"""Typing signals validate membership and never accept or store draft text."""
import json
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import community

@contextmanager
def connection(db):
    yield db

class TypingTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.app = FastAPI(); self.app.include_router(community.router)
        self.app.dependency_overrides[community.current_user] = lambda: {'username':'alice'}
        self.client = TestClient(self.app)
        self.addCleanup(patch.stopall)
        patch.object(community, 'ensure_schema').start()
        patch.object(community.job_queue, '_connect', lambda: connection(self.db)).start()
        self.db.execute.return_value.fetchone.return_value = {'name':'Alice'}

    def test_typing_has_only_ephemeral_signal_and_safe_profile_name(self):
        response = self.client.post('/api/community/rooms/3/typing',json={'typing':True})
        self.assertEqual(response.status_code,200,response.text)
        queries = [call.args for call in self.db.execute.call_args_list]
        self.assertFalse(any(args[0].lstrip().startswith(('INSERT', 'UPDATE', 'DELETE')) for args in queries))
        notify = queries[-1]
        self.assertIn('pg_notify',notify[0])
        payload = json.loads(notify[1][0])
        self.assertEqual(payload,dict(type='typing',room_id=3,username='alice',display_name='Alice',typing=True,parent_id=None))
        self.assertEqual(self.client.post('/api/community/rooms/3/typing',json={'typing':False}).status_code,200)

    def test_draft_text_is_rejected_and_never_published(self):
        self.assertEqual(self.client.post('/api/community/rooms/3/typing',json={'typing':True,'draft':'private words'}).status_code,422)
        self.db.execute.assert_not_called()

    def test_outsider_and_cross_origin_are_rejected(self):
        self.db.execute.return_value.fetchone.return_value = None
        self.assertEqual(self.client.post('/api/community/rooms/3/typing',json={'typing':True}).status_code,404)
        self.db.reset_mock()
        self.assertEqual(self.client.post('/api/community/rooms/3/typing',json={'typing':True},headers={'origin':'https://wrong.example'}).status_code,403)
        self.db.execute.assert_not_called()

    def test_thread_must_belong_to_the_same_room(self):
        self.db.execute.return_value.fetchone.side_effect=[{'username':'alice'},None]
        self.assertEqual(self.client.post('/api/community/rooms/3/typing',json={'typing':True,'parent_id':99}).status_code,404)
        self.assertFalse(any('pg_notify' in call.args[0] for call in self.db.execute.call_args_list))

class TypingSocketDatabaseTests(unittest.TestCase):
    def test_socket_forwards_only_current_room_members(self):
        import os, uuid
        from threading import Event, Thread
        from unittest.mock import AsyncMock
        from starlette.websockets import WebSocketDisconnect
        if not os.environ.get('DATABASE_URL'): self.skipTest('Requires PostgreSQL')
        community.ensure_schema()
        names = ['typingtest_' + uuid.uuid4().hex for _ in range(3)]
        rooms = []
        with community.job_queue._connect() as db:
            for name in names: db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES (%s,%s,false)',(name,'disabled-test-account'))
        try:
            room = community.create_room(community.RoomCreate(kind='direct',peer=names[1]), {'username':names[0]})['id']; rooms.append(room)
            foreign = community.create_room(community.RoomCreate(kind='channel',name='Typing fixture',visibility='private',members=[names[0]]), {'username':names[2]})['id']; rooms.append(foreign)
            listening, foreign_checked = Event(), Event()
            original = community.psycopg.AsyncConnection.connect
            class Connection:
                def __init__(self, db): self.db = db
                async def __aenter__(self): return self
                async def __aexit__(self,*args): await self.db.close()
                async def execute(self,sql,params=None):
                    cursor = await self.db.execute(sql,params)
                    if sql == 'LISTEN bob_community_typing': listening.set()
                    elif params and params[0] == foreign: foreign_checked.set()
                    return cursor
                def notifies(self,**kwargs): return self.db.notifies(**kwargs)
            async def connect(*args,**kwargs): return Connection(await original(*args,**kwargs))
            errors = []
            payload = dict(type='typing',room_id=room,username=names[0],display_name='Alice',typing=True,parent_id=None)
            def publish():
                try:
                    if not listening.wait(5): raise AssertionError('Listener not ready')
                    with community.job_queue._connect() as db: db.execute("SELECT pg_notify('bob_community_typing',%s)",(json.dumps(payload | {'room_id':foreign}),))
                    if not foreign_checked.wait(5): raise AssertionError('Foreign membership not checked')
                    with community.job_queue._connect() as db: db.execute("SELECT pg_notify('bob_community_typing',%s)",(json.dumps(payload),))
                except Exception as e: errors.append(e)
            app=FastAPI(); app.include_router(community.router)
            bob={'username':names[1]}
            from fastapi import HTTPException
            with patch.object(community.psycopg.AsyncConnection,'connect',side_effect=connect), patch.object(community,'current_user',new=AsyncMock(side_effect=[bob,bob,bob,bob,HTTPException(401)])):
                publisher=Thread(target=publish,daemon=True); publisher.start()
                with TestClient(app) as client:
                    with client.websocket_connect('/api/community/ws',headers={'origin':'http://testserver'}) as socket:
                        self.assertEqual(socket.receive_json(), {'type':'ping'})
                        self.assertEqual(socket.receive_json(), payload)
                        with self.assertRaises(WebSocketDisconnect): socket.receive_json()
                publisher.join(5)
            self.assertEqual(errors,[])
        finally:
            with community.job_queue._connect() as db:
                db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE id=ANY(%s)',(rooms,))
                db.execute('DELETE FROM users WHERE username=ANY(%s)',(names,))

if __name__ == '__main__': unittest.main()
