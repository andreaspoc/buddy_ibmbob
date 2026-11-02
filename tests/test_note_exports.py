"""Real PostgreSQL ownership and Chromium PDF export verification."""
import os
import unittest
from uuid import uuid4
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import notes, note_exports, job_queue


class NoteExportLanguageTests(unittest.TestCase):
    def test_greek_labels_preserve_user_content(self):
        document = note_exports.markdown_document([{'title':'Original title', 'body':'Original content',
            'collection':'', 'tags':['Original tag'], 'sources':[{'title':'Original source', 'url':'https://example.org'}]}], 'el')
        for label in ('# Αποθηκευμένες σημειώσεις', '## Εισερχόμενα', 'Ετικέτες:', 'Πηγές:'):
            self.assertIn(label, document)
        for content in ('Original title', 'Original content', 'Original tag', 'Original source'):
            self.assertIn(content, document)


@unittest.skipUnless(os.environ.get('DATABASE_URL'), 'Requires PostgreSQL')
class NoteExportTests(unittest.TestCase):
    def test_owner_selection_markdown_and_real_pdf(self):
        app = FastAPI(); app.include_router(notes.router); app.include_router(note_exports.router)
        owner = 'export-check-' + uuid4().hex
        other = 'export-other-' + uuid4().hex
        ids = []
        with TestClient(app) as client:
            self.assertEqual(client.get('/api/notes/export').status_code, 401)
            try:
                app.dependency_overrides[notes.current_user] = lambda: {'username': owner}
                for title, collection in [('First export', 'One'), ('Second export', 'Two')]:
                    response = client.post('/api/notes', json={'title':title, 'body':'**Real content**\n[Source](https://example.org)\n<script>bad()</script>', 'collection':collection})
                    self.assertEqual(response.status_code, 201, response.text)
                    ids.append(response.json()['id'])
                query = ','.join(map(str, ids))
                response = client.get('/api/notes/export', params={'ids':query})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn('First export', response.text); self.assertIn('Second export', response.text)
                self.assertIn('[Source](https://example.org)', response.text)
                self.assertIn('attachment;', response.headers['content-disposition'])
                response = client.get('/api/notes/export', params={'ids':query, 'language':'el'})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn('# Αποθηκευμένες σημειώσεις', response.text)
                self.assertIn('First export', response.text)
                self.assertIn('**Real content**', response.text)
                self.assertEqual(client.get('/api/notes/export', params={'language':'invalid'}).status_code, 422)
                response = client.get('/api/notes/export', params=[('collection','One'),('collection','Two')])
                self.assertEqual(response.status_code, 200)
                response = client.get('/api/notes/export', params={'format':'pdf','ids':query})
                self.assertEqual(response.status_code, 200, response.text[:300])
                self.assertTrue(response.content.startswith(b'%PDF-'))
                self.assertGreater(len(response.content), 1000)
                response = client.get('/api/notes/export', params={'format':'pdf', 'ids':query, 'language':'el'})
                self.assertEqual(response.status_code, 200, response.text[:300])
                self.assertTrue(response.content.startswith(b'%PDF-'))
                self.assertEqual(client.get('/api/notes/export?ids=0').status_code, 422)
                self.assertEqual(client.get('/api/notes/export?format=html').status_code, 422)
                app.dependency_overrides[notes.current_user] = lambda: {'username': other}
                self.assertEqual(client.get('/api/notes/export',params={'ids':query}).status_code, 404)
                self.assertEqual(client.get('/api/notes/export',params={'collection':'One'}).status_code, 404)
            finally:
                with job_queue._connect() as db:
                    db.execute('DELETE FROM bob_notes WHERE username=%s',(owner,))
                app.dependency_overrides.clear()


if __name__ == '__main__':
    unittest.main()
