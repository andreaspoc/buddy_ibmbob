"""Learning API authorization, grading privacy and immutable-answer boundary tests.

The database is a controlled test double; these are synthetic records, not users
or assessments from a running learning installation.
"""
import json
import hashlib
import copy
from datetime import datetime, timezone
import unittest
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from app.auth import current_user
from buddy_learning import service, lessons  # Register routes before dependencies are mocked.

FOLDER = UUID('11111111-1111-4111-8111-111111111111')
BOOK = UUID('22222222-2222-4222-8222-222222222222')
QUIZ = UUID('33333333-3333-4333-8333-333333333333')
SUBMISSION = UUID('44444444-4444-4444-8444-444444444444')


def private_spec():
    return {'title': 'Published fixture title', 'book_id': None, 'questions': [
        {'id': 'choice', 'type': 'single', 'question': 'Choose a fixture option',
         'options': ['Public A', 'Public B'], 'answer': [1], 'points': 3, 'rubric': None},
        {'id': 'written', 'type': 'text', 'question': 'Explain the fixture concept',
         'options': [], 'answer': 'SECRET_REFERENCE', 'points': 5, 'rubric': 'SECRET_RUBRIC'}]}


class Cursor:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows if rows is not None else ([] if row is None else [row])

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class Database:
    def __init__(self):
        self.allowed = True
        self.status = 'published'
        self.teacher = False
        self.created_by = 'synthetic-creator'
        self.created_quiz = None
        self.edited = None
        self.closed = False
        self.version = 1
        self.previous = None
        self.request_used = False
        self.calls = []
        self.notes = []
        self.inserted = None
        self.graded = None
        self.saved_submission = None
        self.submission = {'id': SUBMISSION, 'quiz_id': QUIZ, 'username': 'synthetic-learner', 'questions': private_spec()['questions'],
                           'grades': {'choice': {'score': 3, 'feedback': ''}, 'written': {'score': None, 'feedback': ''}}}

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        normalized = ' '.join(sql.split())
        if normalized.startswith('SELECT id,chapter_id,page,color,text,created_at FROM learning.reader_notes'):
            return Cursor(rows=[note for note in self.notes if note['owner'] == params[1]])
        if normalized.startswith('INSERT INTO learning.reader_notes'):
            note = dict(zip(['id','book_id','owner','chapter_id','page','color','text'], params))
            self.notes.append(note)
            return Cursor({key: note[key] for key in ['id','chapter_id','page','color','text']})
        if normalized.startswith('DELETE FROM learning.reader_notes'):
            match = next((note for note in self.notes if note['id'] == params[0] and note['book_id'] == params[1] and note['owner'] == params[2]), None)
            if match: self.notes.remove(match)
            return Cursor({'id': match['id']} if match else None)
        if normalized.startswith('SELECT * FROM learning.folders'):
            return Cursor({'id': FOLDER, 'name': 'Synthetic restricted folder'})
        if normalized.startswith('SELECT 1 FROM bob_app_roles'):
            return Cursor()
        if normalized.startswith('SELECT 1 FROM bob_keycloak_identities') and 'JOIN bob_keycloak_group_memberships m' in normalized:
            return Cursor({'allowed': 1} if self.teacher else None)
        if normalized.startswith(('SELECT 1 FROM learning.members', 'SELECT 1 FROM bob_keycloak_identities', 'WITH RECURSIVE ancestor_ids', 'WITH RECURSIVE app_ancestor_ids')):
            return Cursor({'allowed': 1} if self.allowed else None)
        if normalized.startswith('SELECT * FROM learning.books'):
            return Cursor({'id': BOOK, 'folder_id': FOLDER, 'title': 'Synthetic book', 'author': 'Fixture author', 'object_key': 'synthetic/source.epub'})
        if normalized.startswith('SELECT * FROM learning.quizzes'):
            return Cursor({'id': QUIZ, 'folder_id': FOLDER, 'title': 'Unpublished draft title', 'status': self.status, 'version': self.version, 'created_by': self.created_by,
                           'published': private_spec(), 'draft': {**private_spec(), 'title': 'Unpublished draft title'}})
        if normalized.startswith('INSERT INTO learning.quizzes'):
            self.created_quiz = params
            return Cursor({'id': QUIZ, 'title': params[3], 'status': 'draft', 'version': 0})
        if normalized.startswith('UPDATE learning.quizzes SET title'):
            self.edited = params
            return Cursor()
        if normalized.startswith("UPDATE learning.quizzes SET published=draft"):
            return Cursor({'version': self.version + 1})
        if normalized.startswith("UPDATE learning.quizzes SET status='closed'"):
            self.closed = True
            return Cursor()
        if normalized.startswith('SELECT digest FROM learning.submissions'):
            return Cursor(self.previous)
        if normalized.startswith('SELECT 1 FROM learning.submissions WHERE username'):
            return Cursor({'exists': 1} if self.request_used else None)
        if normalized.startswith('SELECT 1 FROM learning.submissions WHERE quiz_id'):
            row = self.saved_submission
            return Cursor({'exists': 1} if row and row['quiz_version'] == params[1] and row['username'] == params[2] else None)
        if normalized.startswith('SELECT username,display_name FROM bob_user_profiles'):
            return Cursor(rows=[{'username': name, 'display_name': 'Fixture Learner'} for name in params[0]])
        if normalized.startswith('INSERT INTO learning.submissions'):
            self.inserted = params
            self.saved_submission = {'id': params[0], 'username': params[3], 'quiz_version': params[2],
                'submitted_at': datetime.now(timezone.utc), 'answers': params[6].obj, 'questions': params[7].obj,
                'grades': params[8].obj, 'score': params[9], 'max_score': params[10], 'pending_manual': params[11]}
            return Cursor()
        if normalized.startswith('SELECT id,username,quiz_version,submitted_at,answers,questions,grades,score,max_score,pending_manual'):
            row = self.saved_submission
            if not row and self.previous:
                row = {**self.submission, 'username': 'synthetic-learner', 'quiz_version': 1,
                    'submitted_at': datetime.now(timezone.utc), 'answers': {'choice': [1], 'written': 'Saved fixture'},
                    'score': 3, 'max_score': 8, 'pending_manual': True}
            if 'username=%s' in normalized:
                return Cursor(copy.deepcopy(row) if row and row['username'] == params[2] and row['quiz_version'] == params[1] else None)
            return Cursor(rows=[copy.deepcopy(row)] if row else [])
        if normalized.startswith('SELECT quiz_id,questions,answers FROM learning.submissions'):
            return Cursor({**self.submission, 'answers': {'choice': [1], 'written': 'Fixture answer'}})
        if normalized.startswith('SELECT * FROM learning.submissions'):
            return Cursor(self.submission)
        if normalized.startswith('UPDATE learning.submissions SET grades'):
            self.graded = params
            if self.saved_submission and (len(params) == 4 or self.saved_submission['grades'] == params[4].obj):
                self.saved_submission.update(grades=params[0].obj, score=params[1], pending_manual=params[2])
            return Cursor()
        if normalized.startswith('INSERT INTO learning.quiz_starts'):
            return Cursor()
        if normalized.startswith('SELECT pg_advisory_xact_lock'):
            return Cursor()
        raise AssertionError('Unexpected database request: ' + normalized)


class LearningAccessTests(unittest.TestCase):
    def setUp(self):
        self.user = {'username': 'synthetic-learner', 'display_name': 'Fixture Learner', 'is_admin': False}
        self.db = Database()
        @contextmanager
        def connect():
            yield self.db
        self.connection = patch.object(service.job_queue, '_connect', connect)
        self.connection.start()
        async def automatic(row, language):
            return {**row['grades'], 'written': {'score': 4, 'feedback': 'Synthetic rubric feedback', 'method': 'ai'}}
        self.auto_grading = patch.object(service, 'automatic_written_grades', new=AsyncMock(side_effect=automatic))
        self.auto_grading.start()
        self.boundary = patch('app.auth.current_user', new=AsyncMock(side_effect=lambda request: self.user))
        self.boundary.start()
        self.app = service.create_app()
        self.app.dependency_overrides[current_user] = lambda: self.user
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.connection.stop()
        self.auto_grading.stop()
        self.boundary.stop()

    def submission(self, **changes):
        return {'version': 1, 'request_id': str(uuid4()), 'answers': {'choice': [1], 'written': 'Synthetic response'}, **changes}

    def test_anonymous_learning_request_is_rejected_before_database_access(self):
        self.user = None
        response = self.client.get('/api/learning/folders')
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.db.calls, [])

    def test_identical_submission_retry_returns_existing_attempt_without_inserting(self):
        payload = self.submission()
        self.db.previous = {'digest': hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()}
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['submitted'])
        self.assertEqual(response.json()['result']['username'], self.user['username'])
        self.assertIsNone(self.db.inserted)
        changed = {**payload, 'answers': {'choice': [0], 'written': 'Revised response'}}
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=changed)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNone(self.db.inserted)

    def test_learner_cannot_read_admin_routes_or_manage_content(self):
        requests = [
            ('get', '/users', None), ('post', '/folders', {'name': 'No'}),
            ('patch', f'/folders/{FOLDER}', {'name': 'No'}), ('get', f'/folders/{FOLDER}/members', None),
            ('put', f'/folders/{FOLDER}/members', {'usernames': []}),
            ('post', f'/folders/{FOLDER}/quizzes', private_spec()),
            ('put', f'/quizzes/{QUIZ}', private_spec()), ('post', f'/quizzes/{QUIZ}/publish', {}),
            ('post', f'/quizzes/{QUIZ}/close', {}), ('get', f'/quizzes/{QUIZ}/results', None),
            ('get', f'/quizzes/{QUIZ}/results.csv', None), ('delete', f'/books/{BOOK}', None),
            ('put', f'/submissions/{SUBMISSION}/grade', {'grades': {'written': {'score': 5}}}),
            ('post', f'/books/{BOOK}/quiz-draft', {'title': 'No', 'count': 2}),
        ]
        for method, path, body in requests:
            with self.subTest(path=path):
                kwargs = {'json': body} if body is not None else {}
                response = getattr(self.client, method)('/api/learning' + path, **kwargs)
                self.assertEqual(response.status_code, 403, response.text)
        self.assertTrue(all('learning.' not in sql for sql, _ in self.db.calls))

    def test_revocation_blocks_every_book_route_before_cached_content_load(self):
        self.db.allowed = False
        requests = [('get', f'/books/{BOOK}', None), ('get', f'/books/{BOOK}/chapters/0', None),
                    ('get', f'/books/{BOOK}/assets/cover.png', None), ('get', f'/books/{BOOK}/search?q=fixture', None),
                    ('put', f'/books/{BOOK}/progress', {'chapter_id': '0', 'bookmarks': []}),
                    ('get', f'/books/{BOOK}/notes', None),
                    ('post', f'/books/{BOOK}/notes', {'chapter_id':'0','text':'Private note'}),
                    ('delete', f'/books/{BOOK}/notes/{uuid4()}', None)]
        with patch.object(service, 'parsed_book') as parsed:
            for method, path, body in requests:
                with self.subTest(path=path):
                    kwargs = {'json': body} if body is not None else {}
                    response = getattr(self.client, method)('/api/learning' + path, **kwargs)
                    self.assertEqual(response.status_code, 404, response.text)
            parsed.assert_not_called()

    def test_reading_notes_are_private_and_recheck_access(self):
        with patch.object(service, 'parsed_book', return_value={'chapters':[{'id':'0'}]}):
            response = self.client.post(f'/api/learning/books/{BOOK}/notes', json={'chapter_id':'0','page':2,'color':'purple','text':'Private note'})
        self.assertEqual(response.status_code, 200, response.text)
        note = response.json()
        self.assertEqual(note['page'], 2)
        self.assertEqual(note['color'], 'purple')
        self.assertEqual(len(self.client.get(f'/api/learning/books/{BOOK}/notes').json()['items']), 1)
        self.user = {'username':'another-learner','is_admin':False}
        self.assertEqual(self.client.get(f'/api/learning/books/{BOOK}/notes').json()['items'], [])
        self.assertEqual(self.client.delete(f"/api/learning/books/{BOOK}/notes/{note['id']}").status_code, 404)
        self.user = {'username':'synthetic-learner','is_admin':False}
        self.assertEqual(self.client.delete(f"/api/learning/books/{BOOK}/notes/{note['id']}").status_code, 200)
        self.assertEqual(self.db.notes, [])

    def test_revocation_blocks_quiz_read_and_submission(self):
        self.db.allowed = False
        for method, path, body in [('get', f'/folders/{FOLDER}/contents', None),
                                   ('get', f'/quizzes/{QUIZ}', None),
                                   ('post', f'/quizzes/{QUIZ}/submit', self.submission())]:
            with self.subTest(path=path):
                response = getattr(self.client, method)('/api/learning' + path, **({'json': body} if body is not None else {}))
                self.assertEqual(response.status_code, 404, response.text)
        self.assertIsNone(self.db.inserted)

    def test_learner_never_receives_answer_keys_or_grading_rubrics(self):
        response = self.client.get(f'/api/learning/quizzes/{QUIZ}')
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        for question in body['questions']:
            self.assertEqual(set(question), {'id', 'type', 'question', 'options', 'points'})
        self.assertNotIn('SECRET_', response.text)
        self.assertEqual(body['title'], 'Published fixture title')
        self.assertNotIn('Unpublished draft title', response.text)
        self.assertNotIn('"answer"', response.text)
        self.assertNotIn('"rubric"', response.text)
        self.assertIn('no-store', response.headers['cache-control'])

    def test_drafts_are_hidden_from_participants(self):
        self.db.status = 'draft'
        response = self.client.get(f'/api/learning/quizzes/{QUIZ}')
        self.assertEqual(response.status_code, 404)
        self.assertNotIn('SECRET_', response.text)

    def test_submission_returns_saved_results_after_server_side_grading(self):
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['submitted'])
        self.assertEqual(response.json()['result']['username'], self.user['username'])
        inserted = self.db.inserted
        self.assertIsNotNone(inserted)
        self.assertEqual(inserted[3], self.user['username'])
        self.assertEqual(inserted[-3:], (3.0, 8.0, True))
        self.assertEqual(inserted[-4].obj['written']['score'], None)
        report = response.json()['result']
        self.assertEqual(report['score'], 7)
        self.assertFalse(report['pending_manual'])
        self.assertEqual(report['grades']['written']['feedback'], 'Synthetic rubric feedback')
        self.assertEqual(report['questions'][1]['answer'], 'SECRET_REFERENCE')

    def test_admin_receives_the_same_persisted_results_as_the_submitting_learner(self):
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
        self.assertEqual(response.status_code, 200, response.text)
        personal = response.json()['result']
        self.user = {'username': 'synthetic-admin', 'is_admin': True}
        response = self.client.get(f'/api/learning/quizzes/{QUIZ}/results')
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()['items'][0]
        for field in ('id', 'display_name', 'quiz_version', 'score', 'max_score', 'grades', 'questions', 'answers'):
            self.assertEqual(saved[field], personal[field])

    def test_stale_version_and_closed_quiz_reject_submission(self):
        for changes in ({'version': 2}, {'status': 'closed'}):
            self.db.version = changes.get('version', 1)
            self.db.status = changes.get('status', 'published')
            response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
            self.assertEqual(response.status_code, 409, response.text)
            self.assertIsNone(self.db.inserted)

    def test_malformed_answers_do_not_write_or_disclose_keys(self):
        for answers in ({'choice': [0]}, {'choice': [20], 'written': 'Response'},
                        {'choice': [1], 'written': 'Response', 'unknown': [1]}):
            response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission(answers=answers))
            self.assertEqual(response.status_code, 422, response.text)
            self.assertNotIn('SECRET_', response.text)
            self.assertIsNone(self.db.inserted)

    def test_cross_origin_writes_rejected_before_storage(self):
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission(), headers={'Origin': 'https://untrusted.invalid'})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.db.calls, [])

    def test_manual_grading_only_accepts_written_question_and_maximum(self):
        self.user = {'username': 'synthetic-admin', 'is_admin': True}
        for grades in ({'choice': {'score': 3}}, {'unknown': {'score': 1}}, {'written': {'score': 6}}):
            response = self.client.put(f'/api/learning/submissions/{SUBMISSION}/grade', json={'grades': grades})
            self.assertEqual(response.status_code, 422, response.text)
            self.assertIsNone(self.db.graded)
        response = self.client.put(f'/api/learning/submissions/{SUBMISSION}/grade', json={'grades': {'written': {'score': 4, 'feedback': 'Synthetic admin feedback'}}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.graded[1:3], (7.0, False))

    def test_personal_results_are_available_only_after_own_submission(self):
        url = f'/api/learning/quizzes/{QUIZ}/my-result'
        self.assertEqual(self.client.get(url).status_code, 404)
        submitted = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
        self.assertEqual(submitted.status_code, 200, submitted.text)
        report = self.client.get(url)
        self.assertEqual(report.status_code, 200, report.text)
        data = report.json()
        self.assertEqual(data['score'], 7)
        self.assertFalse(data['pending_manual'])
        self.assertEqual(data['grades']['choice']['outcome'], 'correct')
        self.assertEqual(data['grades']['written']['outcome'], 'partial')
        self.assertEqual(data['questions'][1]['answer'], 'SECRET_REFERENCE')
        self.user['username'] = 'another-learner'
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.post(url + '/grade', json={}).status_code, 404)

    def test_personal_results_remain_scoped_to_the_submitted_version(self):
        self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
        self.db.version = 2
        url = f'/api/learning/quizzes/{QUIZ}/my-result'
        self.assertEqual(self.client.get(url).status_code, 404)
        response = self.client.get(url + '?version=1')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['quiz_version'], 1)

    def test_reopening_a_submitted_quiz_includes_its_saved_personal_report(self):
        submitted = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
        self.assertEqual(submitted.status_code, 200, submitted.text)
        reopened = self.client.get(f'/api/learning/quizzes/{QUIZ}')
        self.assertEqual(reopened.status_code, 200, reopened.text)
        self.assertTrue(reopened.json()['submitted'])
        self.assertEqual(reopened.json()['result'], submitted.json()['result'])
        self.assertEqual(reopened.json()['result']['display_name'], 'Fixture Learner')

    def test_automatic_failure_keeps_submission_and_pending_written_mark(self):
        with patch.object(service, 'automatic_written_grades', new=AsyncMock(side_effect=TimeoutError())):
            response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.db.saved_submission['pending_manual'])
        self.assertIsNone(self.db.saved_submission['grades']['written']['score'])
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/my-result/grade', json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()['pending_manual'])

    def test_grading_does_not_overwrite_concurrent_admin_changes(self):
        async def concurrent_mark(row, language):
            self.db.saved_submission['grades']['written'] = {'score': 5, 'feedback': 'Administrator mark', 'method': 'administrator'}
            self.db.saved_submission['score'] = 8
            self.db.saved_submission['pending_manual'] = False
            return {**row['grades'], 'written': {'score': 1, 'feedback': 'Older automatic mark', 'method': 'ai'}}
        with patch.object(service, 'automatic_written_grades', new=AsyncMock(side_effect=concurrent_mark)):
            response = self.client.post(f'/api/learning/quizzes/{QUIZ}/submit', json=self.submission())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.saved_submission['grades']['written']['score'], 5)


class LearningTeacherTests(unittest.TestCase):
    setUp = LearningAccessTests.setUp
    tearDown = LearningAccessTests.tearDown

    def as_teacher(self, *, creator=True):
        self.user = {'username': 'synthetic-teacher', 'is_admin': False}
        self.db.teacher = True
        self.db.created_by = self.user['username'] if creator else 'another-teacher'

    def test_teacher_creates_only_in_assigned_folder_and_is_attributed_as_creator(self):
        self.as_teacher()
        response = self.client.post(f'/api/learning/folders/{FOLDER}/quizzes', json=private_spec())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['status'], 'draft')
        self.assertEqual(self.db.created_quiz[-1], self.user['username'])
        self.db.created_quiz = None
        self.db.allowed = False
        response = self.client.post(f'/api/learning/folders/{FOLDER}/quizzes', json=private_spec())
        self.assertEqual(response.status_code, 404, response.text)
        self.assertIsNone(self.db.created_quiz)

    def test_teacher_cannot_grant_folder_access_or_upload_library_books(self):
        self.as_teacher()
        for method, path, body in [
            ('get', '/users', None), ('get', '/groups', None), ('post', '/folders', {'name':'No'}),
            ('put', f'/folders/{FOLDER}/members', {'usernames':[], 'groups':['/teacher']}),
        ]:
            with self.subTest(path=path):
                response = getattr(self.client, method)('/api/learning' + path, **({'json':body} if body is not None else {}))
                self.assertEqual(response.status_code, 403, response.text)
        response = self.client.post(f'/api/learning/folders/{FOLDER}/books', files={'file':('fixture.epub', b'fixture', 'application/epub+zip')})
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.db.calls, [])

    def test_teacher_reviews_only_own_quiz_results_and_written_marks(self):
        self.as_teacher()
        self.assertEqual(self.client.get(f'/api/learning/quizzes/{QUIZ}/results').status_code, 200)
        self.assertEqual(self.client.get(f'/api/learning/quizzes/{QUIZ}/results.csv').status_code, 200)
        self.assertEqual(self.client.put(f'/api/learning/submissions/{SUBMISSION}/grade', json={'grades': {'written': {'score': 3}}}).status_code, 200)
        self.as_teacher(creator=False)
        self.db.graded = None
        for method, path, body in [
            ('get', f'/quizzes/{QUIZ}/results', None),
            ('get', f'/quizzes/{QUIZ}/results.csv', None),
            ('put', f'/submissions/{SUBMISSION}/grade', {'grades': {'written': {'score': 3}}}),
            ('post', f'/submissions/{SUBMISSION}/suggest-grades', {}),
        ]:
            with self.subTest(path=path):
                response = getattr(self.client, method)('/api/learning' + path, **({'json': body} if body is not None else {}))
                self.assertEqual(response.status_code, 403, response.text)
        self.assertIsNone(self.db.graded)
        self.db.allowed = False
        self.as_teacher()
        self.assertEqual(self.client.get(f'/api/learning/quizzes/{QUIZ}/results').status_code, 404)

    def test_creator_sees_and_edits_own_draft_then_approves_publication(self):
        self.as_teacher()
        self.db.status = 'draft'
        response = self.client.get(f'/api/learning/quizzes/{QUIZ}')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['is_creator'])
        self.assertIn('SECRET_REFERENCE', response.text)
        response = self.client.put(f'/api/learning/quizzes/{QUIZ}', json=private_spec())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNotNone(self.db.edited)
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/publish', json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['published'])

    def test_other_teacher_or_admin_cannot_read_draft_or_approve_others(self):
        for is_admin in (False, True):
            with self.subTest(is_admin=is_admin):
                self.as_teacher(creator=False)
                self.user['is_admin'] = is_admin
                self.db.status = 'draft'
                for method, path, body in [('get', f'/quizzes/{QUIZ}', None),
                                           ('put', f'/quizzes/{QUIZ}', private_spec()),
                                           ('post', f'/quizzes/{QUIZ}/publish', {})]:
                    response = getattr(self.client, method)('/api/learning' + path, **({'json':body} if body is not None else {}))
                    self.assertEqual(response.status_code, 404, response.text)
                self.db.status = 'closed'
                response = self.client.post(f'/api/learning/quizzes/{QUIZ}/publish', json={})
                self.assertEqual(response.status_code, 403, response.text)

    def test_teacher_does_not_receive_other_creators_reference_answers(self):
        self.as_teacher(creator=False)
        response = self.client.get(f'/api/learning/quizzes/{QUIZ}')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()['is_creator'])
        self.assertEqual(response.json()['title'], 'Published fixture title')
        self.assertNotIn('SECRET_', response.text)

    def test_removed_teacher_role_hides_draft_and_prevents_approval(self):
        self.as_teacher()
        self.db.teacher = False
        for status in ('published', 'closed'):
            with self.subTest(status=status):
                self.db.status = status
                response = self.client.get(f'/api/learning/quizzes/{QUIZ}')
                self.assertEqual(response.status_code, 200, response.text)
                self.assertFalse(response.json()['is_creator'])
                self.assertNotIn('SECRET_', response.text)
                self.assertNotIn('Unpublished draft title', response.text)
        self.db.status = 'draft'
        response = self.client.get(f'/api/learning/quizzes/{QUIZ}')
        self.assertEqual(response.status_code, 404, response.text)
        response = self.client.post(f'/api/learning/quizzes/{QUIZ}/publish', json={})
        self.assertEqual(response.status_code, 403, response.text)

    def test_other_admin_sees_only_published_keys_never_unpublished_draft(self):
        self.as_teacher(creator=False)
        self.user['is_admin'] = True
        response = self.client.get(f'/api/learning/quizzes/{QUIZ}')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()['is_creator'])
        self.assertEqual(response.json()['title'], 'Published fixture title')
        self.assertIn('SECRET_REFERENCE', response.text)
        self.assertNotIn('Unpublished draft title', response.text)



if __name__ == '__main__':
    unittest.main()
