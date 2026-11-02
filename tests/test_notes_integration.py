"""Real PostgreSQL note route isolation; creates and removes one unique test note."""
import os
import json
import unittest
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import notes, sessions, job_queue, unified_search


@unittest.skipUnless(os.environ.get('DATABASE_URL'), 'Requires the application PostgreSQL database')
class NotesDatabaseIsolationTests(unittest.TestCase):
    def test_metadata_versions_and_private_attachments(self):
        app = FastAPI(); app.include_router(notes.router)
        alice = 'note-details-alice-' + uuid4().hex
        bob = 'note-details-bob-' + uuid4().hex
        note_id = None
        with TestClient(app) as client:
            try:
                app.dependency_overrides[notes.current_user] = lambda: {'username':alice}
                initial = client.post('/api/notes', json={'title':'Original', 'body':'Original text',
                    'tags':[' #Research ', 'research'], 'favorite':True,
                    'sources':[{'title':'Reference','url':'https://example.com/docs'}]}).json()
                note_id = initial['id']; base = f'/api/notes/{note_id}'
                self.assertEqual(initial['tags'], ['Research'])
                self.assertTrue(initial['favorite'])
                revised = client.patch(base, json={'body':'Revised text', 'tags':['Planning']})
                self.assertEqual(revised.status_code, 200, revised.text)
                self.assertEqual(revised.json()['title'], 'Original')
                self.assertTrue(revised.json()['favorite'])
                versions = client.get(base + '/versions').json()['items']
                self.assertEqual(len(versions), 1)
                self.assertEqual(versions[0]['snapshot']['body'], 'Original text')
                version_id = versions[0]['id']
                uploaded = client.post(base + '/attachments', files={'file':('../private.txt', b'private attachment', 'text/plain')})
                self.assertEqual(uploaded.status_code, 201, uploaded.text)
                self.assertEqual(uploaded.json()['filename'], 'private.txt')
                attachment_id = uploaded.json()['id']; path = base + f'/attachments/{attachment_id}'
                self.assertEqual(client.get(path).content, b'private attachment')
                self.assertIn('attachment;', client.get(path).headers['content-disposition'])
                self.assertEqual(client.get(base + '/attachments').json()['items'][0]['id'], attachment_id)
                # Other owners cannot observe content, metadata, or revision history.
                app.dependency_overrides[notes.current_user] = lambda: {'username':bob}
                for resource in (base + '/versions', base + '/attachments', path):
                    self.assertEqual(client.get(resource).status_code, 404)
                self.assertEqual(client.post(base + f'/versions/{version_id}/restore').status_code, 404)
                self.assertEqual(client.delete(path).status_code, 404)
                self.assertEqual(client.post(base + '/attachments', files={'file':('bad.txt', b'x')}).status_code, 404)
                app.dependency_overrides[notes.current_user] = lambda: {'username':alice}
                restored = client.post(base + f'/versions/{version_id}/restore')
                self.assertEqual(restored.status_code, 200, restored.text)
                self.assertEqual(restored.json()['body'], 'Original text')
                self.assertEqual(restored.json()['tags'], ['Research'])
                self.assertEqual(restored.json()['sources'], initial['sources'])
                self.assertEqual(client.get(base + '/versions').json()['items'][0]['snapshot']['body'], 'Revised text')
                self.assertEqual(client.get(path).content, b'private attachment')
                self.assertEqual(client.delete(path).status_code, 204)
                self.assertEqual(client.get(path).status_code, 404)
                self.assertEqual(client.post(base + '/attachments', files={'file':('big.bin', b'x'*(10*1024*1024+1))}).status_code, 413)
                for index in range(20):
                    accepted = client.post(base + '/attachments', files={'file':(f'file-{index}.txt', b'x')})
                    self.assertEqual(accepted.status_code, 201, accepted.text)
                self.assertEqual(client.post(base + '/attachments', files={'file':('over-limit.txt', b'x')}).status_code, 409)
            finally:
                if note_id is not None:
                    app.dependency_overrides[notes.current_user] = lambda: {'username':alice}
                    self.assertEqual(client.delete(f'/api/notes/{note_id}').status_code, 204)
                    with job_queue._connect() as db:
                        self.assertEqual(db.execute('SELECT count(*) AS count FROM bob_note_versions WHERE note_id=%s', (note_id,)).fetchone()['count'], 0)
                        self.assertEqual(db.execute('SELECT count(*) AS count FROM bob_note_attachments WHERE note_id=%s', (note_id,)).fetchone()['count'], 0)
                app.dependency_overrides.clear()

    def test_enrichment_workspaces_hidden_without_removing_history(self):
        app = FastAPI(); app.include_router(notes.router)
        alice = 'note-ws-alice-' + uuid4().hex
        bob = 'note-ws-bob-' + uuid4().hex
        created = []
        marker = 'uniquenoteworkspace' + uuid4().hex
        prompt = "Revise this sticky note according to the user's instruction.\nSOURCE NOTE (JSON): {} " + marker

        def workspace(owner, text, purpose='conversation'):
            record = sessions.create_session(owner, purpose=purpose)
            created.append((owner, record['id']))
            with job_queue._connect() as db:
                db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',
                           (owner, record['id'], json.dumps({'type':'request', 'prompt':text})))
            return record['id']

        with TestClient(app) as client:
            self.assertEqual(client.post('/api/notes/workspace').status_code, 401)
            try:
                normal = workspace(alice, 'Normal conversation ' + marker)
                legacy = workspace(alice, prompt)
                missing_marker = workspace(alice, "Revise this sticky note according to the user's instruction. " + marker)
                later_quote = workspace(alice, 'Normal first question ' + marker)
                bob_legacy = workspace(bob, prompt)
                with job_queue._connect() as db:
                    db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',
                               (alice, later_quote, json.dumps({'type':'request', 'prompt':prompt})))
                app.dependency_overrides[notes.current_user] = lambda: {'username':alice}
                response = client.post('/api/notes/workspace')
                self.assertEqual(response.status_code, 201, response.text)
                hidden = response.json()['id']; created.append((alice, hidden))
                self.assertEqual(response.json()['purpose'], 'note_enrichment')
                visible = {item['id'] for item in sessions.list_sessions(alice)}
                self.assertTrue({normal, missing_marker, later_quote}.issubset(visible))
                self.assertNotIn(hidden, visible); self.assertNotIn(legacy, visible)
                self.assertEqual(sessions.get_session(legacy, alice)['purpose'], 'note_enrichment')
                self.assertNotIn('purpose', sessions.get_session(bob_legacy, bob))
                first_call = sessions.list_sessions(alice)
                self.assertEqual(first_call, sessions.list_sessions(alice))
                with self.assertRaises(FileNotFoundError):
                    sessions.get_session(hidden, bob)
                matches = unified_search.search_saved(alice, marker, kind='conversations')['results']
                self.assertEqual({item['session_id'] for item in matches}, {normal, missing_marker, later_quote})
                with job_queue._connect() as db:
                    row = db.execute('SELECT event FROM bob_conversation_history WHERE username=%s AND session_id=%s', (alice, legacy)).fetchone()
                    self.assertEqual(row['event']['prompt'], prompt)
            finally:
                with job_queue._connect() as db:
                    for owner, identifier in created:
                        db.execute('DELETE FROM bob_conversation_history WHERE username=%s AND session_id=%s', (owner, identifier))
                        db.execute('DELETE FROM bob_conversations WHERE username=%s AND id=%s', (owner, identifier))
                app.dependency_overrides.clear()

    def test_only_creator_can_list_update_or_delete_saved_note(self):
        app = FastAPI()
        app.include_router(notes.router)
        alice = 'notes-integration-alice-' + uuid4().hex
        bob = 'notes-integration-bob-' + uuid4().hex
        note_id = None
        with TestClient(app) as client:
            self.assertEqual(client.get('/api/notes').status_code, 401)
            self.assertEqual(client.post('/api/notes', json={'title':'Private', 'body':'Private text'}).status_code, 401)
            try:
                app.dependency_overrides[notes.current_user] = lambda: {'username':alice}
                response = client.post('/api/notes', json={'title':'Integration privacy check', 'body':'Owned only by the test creator.', 'collection':'Integration'})
                self.assertEqual(response.status_code, 201, response.text)
                original = response.json()
                note_id = original['id']
                self.assertEqual(original['collection'], 'Integration')
                self.assertIn(note_id, [item['id'] for item in client.get('/api/notes').json()['items']])

                app.dependency_overrides[notes.current_user] = lambda: {'username':bob}
                self.assertNotIn(note_id, [item['id'] for item in client.get('/api/notes').json()['items']])
                self.assertEqual(client.patch(f'/api/notes/{note_id}', json={'title':'Hijacked', 'body':'Changed'}).status_code, 404)
                self.assertEqual(client.delete(f'/api/notes/{note_id}').status_code, 404)

                app.dependency_overrides[notes.current_user] = lambda: {'username':alice}
                actual = next(item for item in client.get('/api/notes').json()['items'] if item['id'] == note_id)
                self.assertEqual(actual, original)
            finally:
                if note_id is not None:
                    app.dependency_overrides[notes.current_user] = lambda: {'username':alice}
                    self.assertEqual(client.delete(f'/api/notes/{note_id}').status_code, 204)
                    self.assertNotIn(note_id, [item['id'] for item in client.get('/api/notes').json()['items']])
                app.dependency_overrides.clear()


if __name__ == '__main__':
    unittest.main()
