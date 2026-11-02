"""Real PostgreSQL coverage for conversation grants and explicit sharing."""
import os
import uuid
import unittest
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import community as c, job_queue, notes

@unittest.skipUnless(os.getenv('DATABASE_URL'),'requires PostgreSQL')
class CollaborationTests(unittest.TestCase):
    def setUp(self):
        c.ensure_schema(); notes.ensure_schema()
        self.a='collab-'+uuid.uuid4().hex
        self.b=self.a+'b'; self.x=self.a+'x'
        self.user=self.a
        app=FastAPI(); app.include_router(c.router)
        app.dependency_overrides[c.current_user]=lambda:{'username':self.user}
        self.client=TestClient(app)
        with job_queue._connect() as db:
            self.room=db.execute("INSERT INTO people_chat.bob_chat_rooms(kind,name,creator,visibility) VALUES ('channel','test',%s,'private') RETURNING id",(self.a,)).fetchone()['id']
            self.other=db.execute("INSERT INTO people_chat.bob_chat_rooms(kind,name,creator,visibility) VALUES ('channel','other',%s,'private') RETURNING id",(self.x,)).fetchone()['id']
            for room,who in ((self.room,self.a),(self.room,self.b),(self.other,self.x)):
                db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES (%s,%s)',(room,who))
            self.msg=db.execute("INSERT INTO people_chat.bob_chat_messages(room_id,sender,body) VALUES (%s,%s,'Visible content') RETURNING id",(self.room,self.a)).fetchone()['id']
            self.foreign=db.execute("INSERT INTO people_chat.bob_chat_messages(room_id,sender,body) VALUES (%s,%s,'Hidden content') RETURNING id",(self.other,self.x)).fetchone()['id']
            self.note=db.execute("INSERT INTO bob_notes(username,title,body,color) VALUES (%s,'Private title','Private body','butter') RETURNING id",(self.a,)).fetchone()['id']

    def tearDown(self):
        self.client.close()
        with job_queue._connect() as db:
            db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE id=ANY(%s)',([self.room,self.other],))
            db.execute('DELETE FROM bob_notes WHERE username=ANY(%s)',([self.a,self.b,self.x],))
            db.execute('DELETE FROM people_chat.bob_chat_notification_settings WHERE username=ANY(%s)',([self.a,self.b,self.x],))

    def post(self,suffix,body): return self.client.post(f'/api/community/rooms/{self.room}'+suffix,json=body)

    def test_own_note_snapshot_no_private_identifiers_and_independent(self):
        response=self.post('/share',{'kind':'note','note_id':self.note})
        self.assertEqual(response.status_code,200,response.text)
        with job_queue._connect() as db:
            db.execute("UPDATE bob_notes SET body='Changed private' WHERE id=%s",(self.note,))
        self.user=self.b
        rows=self.client.get(f'/api/community/rooms/{self.room}/messages').json()
        shared=next(m for m in rows if m['id']==response.json()['id'])['shared']
        self.assertEqual(shared['body'],'Private body');self.assertTrue(shared['snapshot'])
        self.assertNotIn('note_id',shared);self.assertNotIn('username',shared)
        self.assertEqual(self.post('/share',{'kind':'note','note_id':self.note}).status_code,404)

    def test_nonmembers_rejected_every_content_and_mutation(self):
        self.user=self.x
        for suffix in ('/messages','/files','/tasks','/search?q=Visible','/notifications'):
            self.assertEqual(self.client.get(f'/api/community/rooms/{self.room}'+suffix).status_code,404)
        for suffix,body in (('/share',{'kind':'text','body':'x'}),(f'/messages/{self.msg}/pin',{'pinned':True}),
            (f'/messages/{self.msg}/reactions',{'emoji':'👍'}),(f'/messages/{self.msg}/tasks',{'title':'work','assignee':self.b}),
            (f'/messages/{self.msg}/save-note',{'title':'Saved'})):
            self.assertEqual(self.post(suffix,body).status_code,404,suffix)
        self.assertEqual(self.client.get('/api/community/search?q=Visible').json(),[])

    def test_crossroom_references_denied(self):
        for suffix,body in ((f'/messages/{self.foreign}/pin',{'pinned':True}),
            (f'/messages/{self.foreign}/reactions',{'emoji':'👍'}),
            (f'/messages/{self.foreign}/tasks',{'title':'work','assignee':self.b})):
            self.assertEqual(self.post(suffix,body).status_code,404)
        response=self.client.post(f'/api/community/rooms/{self.room}/messages',data={'body':'reply','parent_id':self.foreign})
        self.assertEqual(response.status_code,404)

    def test_threads_reactions_pins_and_tasks(self):
        result=self.client.post(f'/api/community/rooms/{self.room}/messages',data={'body':'Reply','parent_id':self.msg})
        self.assertEqual(result.status_code,200,result.text)
        self.assertTrue(self.post(f'/messages/{self.msg}/reactions',{'emoji':'👍'}).json()['active'])
        self.assertEqual(self.post(f'/messages/{self.msg}/pin',{'pinned':True}).status_code,200)
        task=self.post(f'/messages/{self.msg}/tasks',{'title':'Do work','assignee':self.b}).json()
        self.user=self.b
        rows=self.client.get(f'/api/community/rooms/{self.room}/messages').json()
        original=next(m for m in rows if m['id']==self.msg)
        self.assertEqual(original['reactions'],[{'emoji':'👍','count':1,'mine':False}]);self.assertTrue(original['pinned'])
        self.assertEqual(original['tasks'][0]['id'],task['id'])
        self.assertEqual(rows[-1]['parent_id'],self.msg)
        self.assertEqual(self.client.patch(f'/api/community/rooms/{self.room}/tasks/{task["id"]}',json={'status':'done'}).status_code,200)
        self.assertEqual(len(self.client.get('/api/community/tasks/my').json()),1)

    def test_revoke_immediately_denies_messages_files_and_tasks(self):
        with job_queue._connect() as db: db.execute('DELETE FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s',(self.room,self.b))
        self.user=self.b
        for suffix in ('/messages','/files','/tasks'):
            self.assertEqual(self.client.get(f'/api/community/rooms/{self.room}'+suffix).status_code,404)

    def test_save_note_only_copies_message_text_into_own_workspace(self):
        self.user=self.b
        result=self.post(f'/messages/{self.msg}/save-note',{'title':'My copy'})
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['body'],'Visible content')
        with job_queue._connect() as db:
            row=db.execute('SELECT username FROM bob_notes WHERE id=%s',(result.json()['id'],)).fetchone()
            self.assertEqual(row['username'],self.b)

    def test_artifact_sharing_does_not_bypass_source_ownership(self):
        from fastapi import HTTPException
        with patch('app.artifacts.scope_for',side_effect=HTTPException(404,'Conversation not found')),patch('app.postgres_storage.get_file') as read:
            result=self.post('/share',{'kind':'artifact','session_id':'foreign','path':'presentation.html'})
            self.assertEqual(result.status_code,404);read.assert_not_called()

    def test_notifications_private_to_current_member(self):
        url=f'/api/community/rooms/{self.room}/notifications'
        self.assertEqual(self.client.put(url,json={'mode':'muted'}).json(),{'mode':'muted'})
        self.user=self.b
        self.assertEqual(self.client.get(url).json(),{'mode':'all'})
        self.assertEqual(self.client.put(url,json={'mode':'malicious'}).status_code,422)

    def test_mentions_validated_and_rooms_filter_latest_qualifying_message(self):
        url=f'/api/community/rooms/{self.room}/messages'
        self.assertEqual(self.client.post(url,data={'body':'bad','mention_ids':'["outsider"]'}).status_code,422)
        self.assertEqual(self.client.post(url,data={'body':'bad','mention_ids':'{}'}).status_code,422)
        valid=self.client.post(url,data={'body':'Mention','mention_ids':__import__('json').dumps([self.b])})
        self.assertEqual(valid.status_code,200,valid.text)
        self.client.post(url,data={'body':'Later unmentioned'})
        self.user=self.b
        self.client.put(f'/api/community/rooms/{self.room}/notifications',json={'mode':'mentions'})
        rooms=self.client.get('/api/community/rooms').json()
        row=next(r for r in rooms if r['id']==self.room)
        self.assertEqual(row['notification_incoming_id'],valid.json()['id'])
        self.assertGreater(row['latest_incoming_id'],row['notification_incoming_id'])
        self.client.put(f'/api/community/rooms/{self.room}/notifications',json={'mode':'muted'})
        row=next(r for r in self.client.get('/api/community/rooms').json() if r['id']==self.room)
        self.assertIsNone(row['notification_incoming_id'])

    def test_quiet_hours_timezone_and_overnight(self):
        from datetime import datetime,timezone
        from app.community_collaboration import notifications_paused
        url='/api/community/notification-settings'
        self.assertFalse(self.client.get(url).json()['quiet_enabled'])
        self.assertEqual(self.client.put(url,json={'timezone':'invalid'}).status_code,422)
        self.assertEqual(self.client.put(url,json={'quiet_enabled':True,'start':'22:00','end':'08:00','timezone':'Europe/London'}).status_code,200)
        with job_queue._connect() as db:
            self.assertTrue(notifications_paused(db,self.a,datetime(2026,10,16,21,0,tzinfo=timezone.utc)))
            self.assertFalse(notifications_paused(db,self.a,datetime(2026,10,16,10,0,tzinfo=timezone.utc)))
        self.user=self.b
        self.assertFalse(self.client.get(url).json()['quiet_enabled'])

    def test_unified_inbox_requires_current_membership_for_messages_and_due_tasks(self):
        from app.notification_inbox import community_notifications
        task=self.post(f'/messages/{self.msg}/tasks',{'title':'Due task','assignee':self.b,'due_at':'2026-01-01T00:00:00Z'})
        self.assertEqual(task.status_code,200,task.text)
        # Inbox reads migration belongs to the notification module.
        with job_queue._connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS bob_notification_reads(username TEXT NOT NULL,notification_id TEXT NOT NULL,read_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(username,notification_id))')
            items=community_notifications(db,self.b)
            self.assertEqual({r['kind'] for r in items},{'community','community_task'})
            self.assertTrue(all(r['room_id']==self.room for r in items))
            db.execute('DELETE FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s',(self.room,self.b))
            self.assertEqual(community_notifications(db,self.b),[])

    def test_exact_seen_newer_reply_does_not_mark_older_root_seen(self):
        reply=self.client.post(f'/api/community/rooms/{self.room}/messages',data={'body':'thread reply','parent_id':self.msg}).json()['id']
        self.user=self.b
        url=f'/api/community/rooms/{self.room}'
        self.assertEqual(self.client.post(url+'/read',json={'message_ids':[reply]}).status_code,200)
        rows=self.client.get('/api/community/rooms').json()
        self.assertEqual(next(r for r in rows if r['id']==self.room)['unread_count'],1)
        receipts=self.client.get(url+'/receipts').json()
        self.assertEqual(next(r for r in receipts if r['username']==self.b)['seen_message_ids'],[reply])
        self.assertEqual(self.client.post(url+'/read',json={'message_ids':[self.foreign]}).status_code,404)
        self.assertEqual(self.client.post(url+'/read',json={'message_ids':[self.msg]}).status_code,200)
        self.assertEqual(next(r for r in self.client.get('/api/community/rooms').json() if r['id']==self.room)['unread_count'],0)

    def test_permanent_deletion_purges_saved_notes_forwarded_copies_tasks_and_bob_derivatives(self):
        shared=self.post('/share',{'kind':'note','note_id':self.note}).json()['id']
        self.user=self.b
        saved=self.post(f'/messages/{shared}/save-note',{'title':'Saved copy'}).json()['id']
        forwarded=self.post('/share',{'kind':'note','note_id':saved}).json()['id']
        composer_forward=self.client.post(f'/api/community/rooms/{self.room}/messages',data={'note_id':saved,'body':'Another copy'}).json()['id']
        task=self.post(f'/messages/{shared}/tasks',{'title':'linked','assignee':self.b}).json()['id']
        with job_queue._connect() as db:
            derived=db.execute("INSERT INTO people_chat.bob_chat_messages(room_id,sender,body) VALUES (%s,%s,'Bob derivative') RETURNING id",(self.room,self.b)).fetchone()['id']
            db.execute('INSERT INTO people_chat.bob_chat_dependencies(source_id,derived_id) VALUES (%s,%s)',(forwarded,derived))
        self.assertEqual(self.client.delete(f'/api/community/rooms/{self.room}/messages/{shared}').status_code,404)
        self.user=self.a
        result=self.client.delete(f'/api/community/rooms/{self.room}/messages/{shared}')
        self.assertEqual(result.status_code,200,result.text)
        with job_queue._connect() as db:
            self.assertEqual(db.execute('SELECT id FROM people_chat.bob_chat_messages WHERE id=ANY(%s)',([shared,forwarded,derived,composer_forward],)).fetchall(),[])
            self.assertIsNone(db.execute('SELECT id FROM bob_notes WHERE id=%s',(saved,)).fetchone())
            self.assertIsNone(db.execute('SELECT id FROM people_chat.bob_chat_tasks WHERE id=%s',(task,)).fetchone())
            self.assertIsNotNone(db.execute('SELECT id FROM bob_notes WHERE id=%s',(self.note,)).fetchone())
            self.assertEqual(db.execute('SELECT * FROM bob_note_versions WHERE note_id=%s',(saved,)).fetchall(),[])

    def test_writes_reject_cross_origin(self):
        response=self.client.post(f'/api/community/rooms/{self.room}/share',json={'kind':'text','body':'x'},headers={'origin':'https://evil.invalid'})
        self.assertEqual(response.status_code,403)

if __name__=='__main__': unittest.main()
