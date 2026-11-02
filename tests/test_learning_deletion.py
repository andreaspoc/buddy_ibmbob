"""Author/activity deletion gates against an isolated disposable PostgreSQL DB.

All identities and learning records below are synthetic. The guard refuses a
production database; set LEARNING_TEST_DATABASE_URL only for the test container.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import contextmanager
from threading import Event
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import auth, job_queue
from app.auth import current_user
from buddy_learning import deletion, service, store
from buddy_learning.classrooms import ensure_folder_classes, authorize_class

DSN = os.getenv('LEARNING_TEST_DATABASE_URL')
FOLDER = '11111111-1111-4111-8111-111111111111'
QUIZ = '22222222-2222-4222-8222-222222222222'


@unittest.skipUnless(DSN, 'Requires the isolated Learning deletion test database')
class LearningDeletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config = conninfo_to_dict(DSN)
        if config.get('host') != 'bob-learning-delete-test-db' or config.get('dbname') != 'fixture':
            raise RuntimeError('Refusing to modify a non-fixture database')
        cls.environment = patch.dict(os.environ, {'DATABASE_URL': DSN})
        cls.environment.start()
        with auth._connect():
            pass
        store.ensure_schema()

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()

    def setUp(self):
        self.user = {'username': 'owner', 'is_admin': False}
        self.spec = {'title': 'Synthetic draft', 'questions': [{
            'id': 'q1', 'type': 'single', 'question': 'Choose a synthetic option',
            'options': ['A', 'B'], 'answer': [0], 'points': 1, 'rubric': None}]}
        with job_queue._connect() as db:
            db.execute('TRUNCATE learning.folders CASCADE')
            for name in ('owner', 'other', 'learner'):
                db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES(%s,%s,false) ON CONFLICT DO NOTHING',
                           (name, 'unused-synthetic-hash'))
            db.execute('INSERT INTO learning.folders(id,name,created_by) VALUES(%s,%s,%s)', (FOLDER, 'Synthetic class', 'owner'))
            db.execute('''INSERT INTO learning.classes(id,folder_id,title,created_by,teacher_username)
                VALUES(%s,%s,%s,%s,%s)''', (FOLDER, FOLDER, 'Synthetic class', 'owner', 'owner'))
            for name in ('owner', 'other', 'learner'):
                db.execute('INSERT INTO learning.members(folder_id,username) VALUES(%s,%s)', (FOLDER, name))
            db.execute('INSERT INTO learning.quizzes(id,folder_id,title,draft,created_by) VALUES(%s,%s,%s,%s,%s)',
                       (QUIZ, FOLDER, 'Synthetic draft', Jsonb(self.spec), 'owner'))
        self.permissions = patch.object(store, 'can_create', side_effect=lambda db, user: user['username'] != 'learner')
        self.permissions.start()
        self.addCleanup(self.permissions.stop)
        self.app = FastAPI()
        self.app.include_router(service.router)
        self.app.include_router(deletion.router)
        self.app.dependency_overrides[current_user] = lambda: self.user
        self.app.dependency_overrides[service.teacher] = lambda: self.user
        self.client = TestClient(self.app, headers={'Origin': 'http://testserver'})
        self.addCleanup(self.client.close)

    def publish(self):
        with job_queue._connect() as db:
            db.execute("UPDATE learning.quizzes SET status='published',version=1,published=draft WHERE id=%s", (QUIZ,))

    def test_author_can_delete_unpublished_draft(self):
        result = self.client.delete('/api/learning/quizzes/' + QUIZ)
        self.assertEqual(result.status_code, 200, result.text)
        with job_queue._connect() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM learning.quizzes WHERE id=%s', (QUIZ,)).fetchone())

    def test_other_author_and_other_admin_cannot_delete_draft(self):
        for admin in (False, True):
            self.user = {'username': 'other', 'is_admin': admin}
            result = self.client.delete('/api/learning/quizzes/' + QUIZ)
            self.assertIn(result.status_code, (403, 404))

    def test_published_and_closed_versions_are_preserved(self):
        self.publish()
        for status in ('published', 'closed', 'draft'):
            with job_queue._connect() as db:
                db.execute('UPDATE learning.quizzes SET status=%s WHERE id=%s', (status, QUIZ))
            self.assertEqual(self.client.delete('/api/learning/quizzes/' + QUIZ).status_code, 409)

    def test_start_is_idempotent_and_prevents_class_deletion(self):
        self.publish()
        self.user = {'username': 'learner', 'is_admin': False}
        for _ in range(2):
            result = self.client.post('/api/learning/quizzes/' + QUIZ + '/start', json={})
            self.assertEqual(result.status_code, 200, result.text)
        self.user = {'username': 'owner', 'is_admin': False}
        self.assertEqual(self.client.delete('/api/learning/classes/' + FOLDER).status_code, 409)
        with job_queue._connect() as db:
            self.assertEqual(db.execute('SELECT count(*) AS n FROM learning.quiz_starts').fetchone()['n'], 1)

    def test_learner_get_also_records_start_for_older_clients(self):
        self.publish()
        self.user = {'username': 'learner', 'is_admin': False}
        result = self.client.get('/api/learning/quizzes/' + QUIZ)
        self.assertEqual(result.status_code, 200, result.text)
        with job_queue._connect() as db:
            self.assertIsNotNone(db.execute('SELECT 1 FROM learning.quiz_starts WHERE quiz_id=%s', (QUIZ,)).fetchone())

    def test_author_review_does_not_start_a_draft(self):
        self.assertEqual(self.client.get('/api/learning/quizzes/' + QUIZ).status_code, 200)
        self.assertEqual(self.client.delete('/api/learning/quizzes/' + QUIZ).status_code, 200)

    def test_unused_class_can_be_deleted_without_resurrection_or_material_loss(self):
        with job_queue._connect() as db:
            db.execute('INSERT INTO learning.class_members(class_id,username) VALUES(%s,%s)', (FOLDER, 'learner'))
        result = self.client.delete('/api/learning/classes/' + FOLDER)
        self.assertEqual(result.status_code, 200, result.text)
        with job_queue._connect() as db:
            ensure_folder_classes(db)
            self.assertEqual(store.visible_folders(db, self.user), [])
            with self.assertRaises(HTTPException):
                authorize_class(db, UUID(FOLDER), self.user)
            self.assertIsNotNone(db.execute('SELECT 1 FROM learning.quizzes WHERE id=%s', (QUIZ,)).fetchone())
        self.assertEqual(self.client.post('/api/learning/quizzes/' + QUIZ + '/start', json={}).status_code, 404)

    def test_only_class_author_can_delete_even_if_another_admin(self):
        self.user = {'username': 'other', 'is_admin': True}
        self.assertEqual(self.client.delete('/api/learning/classes/' + FOLDER).status_code, 403)

    def test_nested_class_must_be_removed_first(self):
        with job_queue._connect() as db:
            db.execute('INSERT INTO learning.folders(id,parent_id,name,created_by) VALUES(%s,%s,%s,%s)',
                       (str(uuid4()), FOLDER, 'Synthetic nested class', 'owner'))
        self.assertEqual(self.client.delete('/api/learning/classes/' + FOLDER).status_code, 409)

    def test_historical_submissions_protect_class(self):
        with job_queue._connect() as db:
            db.execute('''INSERT INTO learning.submissions(id,quiz_id,quiz_version,username,request_id,digest,
                answers,questions,grades,score,max_score,pending_manual) VALUES(%s,%s,1,%s,%s,%s,%s,%s,%s,0,1,false)''',
                (str(uuid4()), QUIZ, 'learner', str(uuid4()), 'synthetic', Jsonb({}), Jsonb([]), Jsonb({})))
        self.assertEqual(self.client.delete('/api/learning/classes/' + FOLDER).status_code, 409)

    def test_lesson_progress_protects_class(self):
        with job_queue._connect() as db:
            lesson = str(uuid4())
            db.execute('INSERT INTO learning.lessons(id,folder_id,title,draft,created_by) VALUES(%s,%s,%s,%s,%s)',
                       (lesson, FOLDER, 'Synthetic lesson', Jsonb({}), 'owner'))
            db.execute('INSERT INTO learning.lesson_progress(lesson_id,username,version) VALUES(%s,%s,1)', (lesson, 'learner'))
        self.assertEqual(self.client.delete('/api/learning/classes/' + FOLDER).status_code, 409)

    def test_deletion_waits_for_inflight_activity_then_rechecks(self):
        self.publish()
        entered = Event()
        def remove():
            entered.set()
            try:
                deletion.delete_class(UUID(FOLDER), self.user)
            except HTTPException as error:
                return error.status_code
            return 200
        with ThreadPoolExecutor(max_workers=1) as executor:
            with job_queue._connect() as db:
                store.folder(db, FOLDER, {'username': 'learner', 'is_admin': False})
                db.execute('INSERT INTO learning.quiz_starts(quiz_id,username) VALUES(%s,%s)', (QUIZ, 'learner'))
                future = executor.submit(remove)
                self.assertTrue(entered.wait(2))
                with self.assertRaises(TimeoutError):
                    future.result(timeout=.2)
            self.assertEqual(future.result(timeout=5), 409)


if __name__ == '__main__':
    unittest.main()
