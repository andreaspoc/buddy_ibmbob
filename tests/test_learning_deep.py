"""Deep coverage unit tests for buddy_learning.service, classrooms, and quiz_ai.

Hermetic tests: no real network, third-party APIs, or live telemetry.
All database sessions and external services are mocked with test doubles.
"""
from contextlib import asynccontextmanager, contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import io
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

from fastapi import FastAPI, HTTPException
from starlette.requests import Request
from pydantic import ValidationError

from app.agent_budget import BudgetExceeded, RunBudget
from buddy_learning import classrooms, quiz_ai, service, store
from buddy_learning.classroom_models import (
    Announcement, AnnouncementUpdate, Assignment, AssignmentUpdate,
    ClassAccessInput, ClassInput, ClassUpdate, Feedback, Homework, Members,
    Session, SessionUpdate,
)
from buddy_learning.quizzes import ManualGrade, ManualGrades, QuizInput, QuizQuestion


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


@asynccontextmanager
async def mock_async_ctx(val=None):
    yield val


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
# Quiz AI Deep Tests
# ==============================================================================
class QuizAIDeepTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.budget = RunBudget('test-teacher')
        self.budget.consume = AsyncMock()

    async def test_create_draft_from_excerpts_requires_budget(self):
        with self.assertRaises(PermissionError):
            await quiz_ai.create_draft_from_excerpts([], "Title", 5, budget=None)

    async def test_create_draft_from_excerpts_queue_timeout(self):
        with patch.object(quiz_ai._slots, 'acquire', side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                await quiz_ai.create_draft_from_excerpts([], "Title", 5, budget=self.budget)

    async def test_create_draft_from_excerpts_success_book(self):
        raw_quiz = {
            'title': 'Synthetic Title',
            'questions': [
                {
                    'id': 'q1',
                    'type': 'single',
                    'question': 'What is synthetic?',
                    'options': ['A', 'B'],
                    'answer': [0],
                    'explanation': 'Because A is synthetic',
                    'study_topic': 'Unit 1',
                    'reading': 'Chapter 1'
                }
            ]
        }
        json_output = "```json\n" + json.dumps(raw_quiz) + "\n```"

        fake_conn = SimpleNamespace(
            initialize=AsyncMock(),
            new_session=AsyncMock(return_value=SimpleNamespace(session_id='s1')),
            prompt=AsyncMock()
        )

        @asynccontextmanager
        async def fake_env(*args, **kwargs):
            yield {}

        @asynccontextmanager
        async def fake_proc(client, *args, **kwargs):
            client.text_chunks.append(json_output)
            yield (fake_conn, Mock())

        with patch('buddy_learning.quiz_ai.approval_child_environment', side_effect=fake_env), \
             patch('buddy_learning.quiz_ai.approval_agent_process', side_effect=fake_proc):
            spec, truncated = await quiz_ai.create_draft_from_excerpts(
                [{'chapter': '1', 'text': 'Content'}],
                "Requested Title",
                1,
                book_id=UUID('11111111-1111-1111-1111-111111111111'),
                language="el",
                budget=self.budget
            )
            self.assertEqual(spec.title, "Requested Title")
            self.assertEqual(spec.book_id, UUID('11111111-1111-1111-1111-111111111111'))
            self.assertEqual(spec.language, "el")
            self.assertFalse(truncated)

    async def test_create_draft_from_excerpts_success_lesson(self):
        raw_quiz = {
            'title': 'Lesson Quiz',
            'questions': [
                {
                    'id': 'lq1',
                    'type': 'text',
                    'question': 'Explain synthetic?',
                    'answer': 'Explanation here',
                    'rubric': 'Must explain',
                    'explanation': 'Explanation',
                    'study_topic': 'Lesson 1',
                    'reading': 'Intro'
                }
            ]
        }

        fake_conn = SimpleNamespace(
            initialize=AsyncMock(),
            new_session=AsyncMock(return_value=SimpleNamespace(session_id='s2')),
            prompt=AsyncMock()
        )

        @asynccontextmanager
        async def fake_proc(client, *args, **kwargs):
            client.text_chunks.append(json.dumps(raw_quiz))
            yield (fake_conn, Mock())

        with patch('buddy_learning.quiz_ai.approval_child_environment', side_effect=lambda *a, **kw: mock_async_ctx({})), \
             patch('buddy_learning.quiz_ai.approval_agent_process', side_effect=fake_proc):
            spec, truncated = await quiz_ai.create_draft_from_excerpts(
                [{'section': 'Intro', 'text': 'Content'}],
                "Lesson Quiz",
                1,
                lesson_id=UUID('22222222-2222-2222-2222-222222222222'),
                language="en",
                truncated=True,
                budget=self.budget
            )
            self.assertEqual(spec.lesson_id, UUID('22222222-2222-2222-2222-222222222222'))
            self.assertTrue(truncated)

    async def test_create_draft_from_excerpts_count_mismatch(self):
        raw_quiz = {
            'title': 'Quiz',
            'questions': [
                {
                    'id': 'q1',
                    'type': 'single',
                    'question': 'Q1',
                    'options': ['A', 'B'],
                    'answer': [0],
                    'explanation': 'E1',
                    'study_topic': 'T1',
                    'reading': 'R1'
                }
            ]
        }
        fake_conn = SimpleNamespace(
            initialize=AsyncMock(),
            new_session=AsyncMock(return_value=SimpleNamespace(session_id='s3')),
            prompt=AsyncMock()
        )

        @asynccontextmanager
        async def fake_proc(client, *args, **kwargs):
            client.text_chunks.append(json.dumps(raw_quiz))
            yield (fake_conn, Mock())

        with patch('buddy_learning.quiz_ai.approval_child_environment', side_effect=lambda *a, **kw: mock_async_ctx({})), \
             patch('buddy_learning.quiz_ai.approval_agent_process', side_effect=fake_proc):
            with self.assertRaises(ValueError) as ctx:
                await quiz_ai.create_draft_from_excerpts([], "Quiz", 2, budget=self.budget)
            self.assertIn("Question count mismatch", str(ctx.exception))

    async def test_create_draft_truncation_logic(self):
        parsed = {
            'title': 'Test Book',
            'chapters': [
                {'id': 'c1', 'title': 'Ch 1'},
                {'id': 'c2', 'title': 'Ch 2'},
            ]
        }
        with patch('buddy_learning.service.chapter_plain', side_effect=['A' * 36000, 'B' * 100]):
            with patch('buddy_learning.quiz_ai.create_draft_from_excerpts', new_callable=AsyncMock) as mock_excerpts:
                mock_excerpts.return_value = (Mock(), True)
                res, trunc = await quiz_ai.create_draft(parsed, "Title", 5, UUID('11111111-1111-1111-1111-111111111111'), budget=self.budget)
                self.assertTrue(trunc)
                mock_excerpts.assert_awaited_once()
                call_args = mock_excerpts.call_args[1]
                self.assertTrue(call_args['truncated'])

    async def test_create_draft_no_truncation(self):
        parsed = {
            'title': 'Short Book',
            'chapters': [{'id': 'c1', 'title': 'Ch 1'}]
        }
        with patch('buddy_learning.service.chapter_plain', return_value='Short text'):
            with patch('buddy_learning.quiz_ai.create_draft_from_excerpts', new_callable=AsyncMock) as mock_excerpts:
                mock_excerpts.return_value = (Mock(), False)
                await quiz_ai.create_draft(parsed, "Title", 1, UUID('11111111-1111-1111-1111-111111111111'), budget=self.budget)
                mock_excerpts.assert_awaited_once()
                self.assertFalse(mock_excerpts.call_args[1]['truncated'])

    async def test_suggest_grades_validations(self):
        # 1. Budget missing
        with self.assertRaises(PermissionError):
            await quiz_ai.suggest_grades([], {}, budget=None)

        # 2. No written questions
        questions = [{'id': 'q1', 'type': 'single', 'points': 5}]
        with self.assertRaises(ValueError) as ctx:
            await quiz_ai.suggest_grades(questions, {'q1': 0}, budget=self.budget)
        self.assertIn("No written answers to grade", str(ctx.exception))

        # 3. Encoded evidence too long
        written = [{'id': 'w1', 'type': 'text', 'question': 'Q', 'answer': 'A', 'rubric': 'R', 'points': 5}]
        long_answers = {'w1': 'X' * 46000}
        with self.assertRaises(ValueError) as ctx:
            await quiz_ai.suggest_grades(written, long_answers, budget=self.budget)
        self.assertIn("Written answers are too long", str(ctx.exception))

    async def test_suggest_grades_queue_timeout(self):
        written = [{'id': 'w1', 'type': 'text', 'question': 'Q', 'answer': 'A', 'rubric': 'R', 'points': 5}]
        with patch.object(quiz_ai._slots, 'acquire', side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                await quiz_ai.suggest_grades(written, {'w1': 'Ans'}, budget=self.budget)

    async def test_suggest_grades_execution_errors_and_success(self):
        written = [{'id': 'w1', 'type': 'text', 'question': 'Q', 'answer': 'A', 'rubric': 'R', 'points': 5}]
        fake_conn = SimpleNamespace(
            initialize=AsyncMock(),
            new_session=AsyncMock(return_value=SimpleNamespace(session_id='s4')),
            prompt=AsyncMock()
        )

        # Incorrect question IDs
        @asynccontextmanager
        async def proc_wrong_id(client, *args, **kwargs):
            client.text_chunks.append(json.dumps({'grades': {'wrong_id': {'score': 4, 'feedback': 'Good'}}}))
            yield (fake_conn, Mock())

        with patch('buddy_learning.quiz_ai.approval_child_environment', side_effect=lambda *a, **kw: mock_async_ctx({})), \
             patch('buddy_learning.quiz_ai.approval_agent_process', side_effect=proc_wrong_id):
            with self.assertRaises(ValueError) as ctx:
                await quiz_ai.suggest_grades(written, {'w1': 'Ans'}, budget=self.budget)
            self.assertIn("incorrect question IDs", str(ctx.exception))

        # Score exceeds maximum
        @asynccontextmanager
        async def proc_excess_score(client, *args, **kwargs):
            client.text_chunks.append(json.dumps({'grades': {'w1': {'score': 10, 'feedback': 'Too high'}}}))
            yield (fake_conn, Mock())

        with patch('buddy_learning.quiz_ai.approval_child_environment', side_effect=lambda *a, **kw: mock_async_ctx({})), \
             patch('buddy_learning.quiz_ai.approval_agent_process', side_effect=proc_excess_score):
            with self.assertRaises(ValueError) as ctx:
                await quiz_ai.suggest_grades(written, {'w1': 'Ans'}, budget=self.budget)
            self.assertIn("exceeds maximum marks", str(ctx.exception))

        # Success automatic=True and automatic=False
        @asynccontextmanager
        async def proc_success(client, *args, **kwargs):
            client.text_chunks.append("```json\n" + json.dumps({'grades': {'w1': {'score': 4, 'feedback': 'Accurate'}}}) + "\n```")
            yield (fake_conn, Mock())

        with patch('buddy_learning.quiz_ai.approval_child_environment', side_effect=lambda *a, **kw: mock_async_ctx({})), \
             patch('buddy_learning.quiz_ai.approval_agent_process', side_effect=proc_success):
            grades = await quiz_ai.suggest_grades(written, {'w1': 'Ans'}, automatic=True, budget=self.budget)
            self.assertEqual(grades.grades['w1'].score, 4)
            self.assertEqual(grades.grades['w1'].feedback, 'Accurate')


# ==============================================================================
# Classrooms Deep Tests
# ==============================================================================
class ClassroomsDeepTests(unittest.TestCase):
    def setUp(self):
        self.cid = UUID('12345678-1234-5678-1234-567812345678')
        self.fid = UUID('87654321-4321-8765-4321-876543210987')
        self.user = {'username': 'teacher1', 'is_admin': False}
        self.admin_user = {'username': 'admin1', 'is_admin': True}

    def test_schema_execution(self):
        db = MockDB()
        classrooms.schema(db)
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS learning.classes' in q[0] for q in db.queries))
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS learning.class_members' in q[0] for q in db.queries))
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS learning.class_announcements' in q[0] for q in db.queries))
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS learning.class_sessions' in q[0] for q in db.queries))

    def test_ensure_folder_classes(self):
        db = MockDB()
        # Returns one folder without class
        db.add_handler('SELECT f.id,f.name,f.created_by FROM learning.folders f', [
            {'id': str(self.fid), 'name': 'Folder 1', 'created_by': 'teacher1'}
        ])
        classrooms.ensure_folder_classes(db)
        self.assertTrue(any('INSERT INTO learning.classes' in q[0] for q in db.queries))

    def test_authorize_class_errors_and_branches(self):
        db = MockDB()
        # 1. Not found
        with self.assertRaises(HTTPException) as ctx:
            classrooms.authorize_class(db, self.cid, self.user)
        self.assertEqual(ctx.exception.status_code, 404)

        # 2. Deleted class
        db.add_handler('SELECT * FROM learning.classes', {'id': str(self.cid), 'deleted': True})
        with self.assertRaises(HTTPException) as ctx:
            classrooms.authorize_class(db, self.cid, self.user)
        self.assertEqual(ctx.exception.status_code, 404)

        # 3. Non-manager attempting manage=True
        db = MockDB()
        db.add_handler('SELECT * FROM learning.classes', {
            'id': str(self.cid), 'folder_id': str(self.fid), 'created_by': 'other_teacher', 'teacher_username': 'other_teacher', 'deleted': False
        })
        with patch('buddy_learning.store.folder', return_value={'id': str(self.fid)}), \
             patch('buddy_learning.store.can_create', return_value=True):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.authorize_class(db, self.cid, self.user, manage=True)
            self.assertEqual(ctx.exception.status_code, 403)

        # 4. Non-manager not enrolled in non-folder class -> 404
        db = MockDB()
        db.add_handler('SELECT * FROM learning.classes', {
            'id': str(self.cid), 'folder_id': str(self.fid), 'created_by': 'other', 'teacher_username': 'other', 'deleted': False
        })
        with patch('buddy_learning.store.folder', return_value={'id': str(self.fid)}), \
             patch('buddy_learning.store.can_create', return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.authorize_class(db, self.cid, self.user)
            self.assertEqual(ctx.exception.status_code, 404)

        # 5. Non-manager not enrolled in folder class (id == folder_id) -> auto-enrolls
        db = MockDB()
        db.add_handler('SELECT * FROM learning.classes', {
            'id': str(self.cid), 'folder_id': str(self.cid), 'created_by': 'other', 'teacher_username': 'other', 'deleted': False
        })
        db.add_handler('SELECT display_name FROM bob_user_profiles', {'display_name': 'Other Teacher'})
        with patch('buddy_learning.store.folder', return_value={'id': str(self.cid)}), \
             patch('buddy_learning.store.can_create', return_value=False):
            course = classrooms.authorize_class(db, self.cid, self.user)
            self.assertEqual(course['id'], str(self.cid))
            self.assertTrue(any('INSERT INTO learning.class_members' in q[0] for q in db.queries))

    def test_checked_teacher(self):
        db = MockDB()
        # 1. User not found
        with self.assertRaises(HTTPException) as ctx:
            classrooms.checked_teacher(db, self.fid, 'nonexistent')
        self.assertEqual(ctx.exception.status_code, 422)

        # 2. User cannot create
        db.add_handler('SELECT username,is_admin FROM users', {'username': 'u1', 'is_admin': False})
        with patch('buddy_learning.store.can_create', return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.checked_teacher(db, self.fid, 'u1')
            self.assertEqual(ctx.exception.status_code, 422)

        # 3. User has no folder access (store.folder raises 404)
        with patch('buddy_learning.store.can_create', return_value=True), \
             patch('buddy_learning.store.folder', side_effect=HTTPException(404, 'Folder not found')):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.checked_teacher(db, self.fid, 'u1')
            self.assertEqual(ctx.exception.status_code, 422)
            self.assertIn("needs current access", ctx.exception.detail)

        # 4. store.folder raises other error
        with patch('buddy_learning.store.can_create', return_value=True), \
             patch('buddy_learning.store.folder', side_effect=HTTPException(500, 'DB Error')):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.checked_teacher(db, self.fid, 'u1')
            self.assertEqual(ctx.exception.status_code, 500)

        # 5. Success
        with patch('buddy_learning.store.can_create', return_value=True), \
             patch('buddy_learning.store.folder', return_value={}):
            person = classrooms.checked_teacher(db, self.fid, 'u1')
            self.assertEqual(person['username'], 'u1')

    def test_revision_and_ensure_open(self):
        with self.assertRaises(HTTPException) as ctx:
            classrooms.revision({'revision': 1}, 2)
        self.assertEqual(ctx.exception.status_code, 409)

        with self.assertRaises(HTTPException) as ctx:
            classrooms.ensure_open({'archived': True})
        self.assertEqual(ctx.exception.status_code, 409)

    def test_assignment_lookup_and_resource(self):
        db = MockDB()
        aid = uuid4()
        # Not found
        with self.assertRaises(HTTPException) as ctx:
            classrooms.assignment(db, self.cid, aid)
        self.assertEqual(ctx.exception.status_code, 404)

        # Resource: type == 'none'
        course = {'id': str(self.cid), 'folder_id': str(self.fid)}
        spec_none = SimpleNamespace(resource_type='none')
        self.assertIsNone(classrooms.resource(db, course, spec_none, self.user))

        # Resource: different folder
        spec_book = SimpleNamespace(resource_type='book', resource_id=uuid4())
        with patch('buddy_learning.store.book', return_value={'folder_id': str(uuid4())}):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.resource(db, course, spec_book, self.user)
            self.assertEqual(ctx.exception.status_code, 422)

        # Resource: quiz not published
        spec_quiz = SimpleNamespace(resource_type='quiz', resource_id=uuid4())
        with patch('buddy_learning.store.quiz', return_value={'folder_id': str(self.fid), 'status': 'draft'}):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.resource(db, course, spec_quiz, self.user)
            self.assertEqual(ctx.exception.status_code, 422)
            self.assertIn("Publish the lesson or quiz", ctx.exception.detail)

        # Resource: lesson published success
        spec_lesson = SimpleNamespace(resource_type='lesson', resource_id=uuid4())
        with patch('buddy_learning.lessons.lookup', return_value=({'folder_id': str(self.fid), 'status': 'published', 'version': 3}, True)):
            ver = classrooms.resource(db, course, spec_lesson, self.user)
            self.assertEqual(ver, 3)

    def test_list_all_classes_and_standalone(self):
        db = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)):
            # 1. Empty folders
            with patch('buddy_learning.store.can_create', return_value=False), \
                 patch('buddy_learning.store.visible_folders', return_value=[]):
                res = classrooms.list_all_classes(user=self.user)
                self.assertEqual(res, {'items': []})

            # 2. create_standalone_class permissions
            req = ClassInput(title="New Course", description="Course desc", teacher_username="other_teacher")
            with patch('buddy_learning.store.folder', return_value={}):
                with self.assertRaises(HTTPException) as ctx:
                    classrooms.create_standalone_class(req, user=self.user)
                self.assertEqual(ctx.exception.status_code, 403)

            # 3. create_standalone_class success
            db.add_handler('SELECT username,is_admin FROM users', {'username': 'teacher1', 'is_admin': False})
            db.add_handler('INSERT INTO learning.classes', {
                'id': str(self.cid), 'folder_id': str(self.cid), 'title': 'New Course',
                'description': 'Course desc', 'created_by': 'teacher1', 'teacher_username': 'teacher1',
                'archived': False, 'revision': 1
            })
            db.add_handler('SELECT display_name FROM bob_user_profiles', {'display_name': 'Teacher 1'})
            with patch('buddy_learning.store.can_create', return_value=True):
                req_self = ClassInput(title="New Course", description="Course desc")
                created = classrooms.create_standalone_class(req_self, user=self.user)
                self.assertEqual(created['title'], 'New Course')
                self.assertTrue(created['can_manage'])

    def test_announcements_crud(self):
        db = MockDB()
        ann_id = uuid4()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.classrooms.authorize_class', return_value={'id': str(self.cid), 'archived': False}):
            # List
            db.add_handler('SELECT * FROM learning.class_announcements', [{'id': str(ann_id), 'title': 'A1', 'body': 'B1'}])
            res = classrooms.announcements(self.cid, user=self.user)
            self.assertEqual(len(res['items']), 1)

            # Post
            db.add_handler('INSERT INTO learning.class_announcements', {'id': str(ann_id), 'title': 'A1', 'body': 'B1'})
            post_res = classrooms.post_announcement(self.cid, Announcement(title='A1', body='B1'), user=self.user)
            self.assertEqual(post_res['title'], 'A1')

            # Edit not found
            db_empty = MockDB()
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_empty)):
                with self.assertRaises(HTTPException) as ctx:
                    classrooms.edit_announcement(self.cid, ann_id, AnnouncementUpdate(title='A2', body='B2', expected_revision=1), user=self.user)
                self.assertEqual(ctx.exception.status_code, 404)

            # Edit success
            db_edit = MockDB()
            db_edit.add_handler('SELECT * FROM learning.class_announcements', {'id': str(ann_id), 'revision': 1})
            db_edit.add_handler('UPDATE learning.class_announcements', {'id': str(ann_id), 'title': 'A2', 'body': 'B2', 'revision': 2})
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_edit)):
                edited = classrooms.edit_announcement(self.cid, ann_id, AnnouncementUpdate(title='A2', body='B2', expected_revision=1), user=self.user)
                self.assertEqual(edited['title'], 'A2')

    def test_sessions_crud(self):
        db = MockDB()
        sid = uuid4()
        now = datetime.now(timezone.utc)
        sess_input = Session(title="S1", description="D1", section="Week 1", starts_at=now, ends_at=now + timedelta(hours=1))

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.classrooms.authorize_class', return_value={'id': str(self.cid), 'archived': False}):
            # List
            db.add_handler('SELECT * FROM learning.class_sessions', [{'id': str(sid), 'title': 'S1'}])
            res = classrooms.sessions(self.cid, user=self.user)
            self.assertEqual(len(res['items']), 1)

            # Create
            db.add_handler('INSERT INTO learning.class_sessions', {'id': str(sid), 'title': 'S1'})
            created = classrooms.create_session(self.cid, sess_input, user=self.user)
            self.assertEqual(created['title'], 'S1')

            # Edit session not found
            db_empty = MockDB()
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_empty)):
                with self.assertRaises(HTTPException) as ctx:
                    classrooms.edit_session(self.cid, sid, SessionUpdate(title='S2', starts_at=now, ends_at=now + timedelta(hours=1), expected_revision=1), user=self.user)
                self.assertEqual(ctx.exception.status_code, 404)

            # Edit session success
            db_sess = MockDB()
            db_sess.add_handler('SELECT * FROM learning.class_sessions', {'id': str(sid), 'revision': 1})
            db_sess.add_handler('UPDATE learning.class_sessions', {'id': str(sid), 'title': 'S2', 'revision': 2})
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_sess)):
                edited = classrooms.edit_session(self.cid, sid, SessionUpdate(title='S2', starts_at=now, ends_at=now + timedelta(hours=1), expected_revision=1), user=self.user)
                self.assertEqual(edited['title'], 'S2')

    def test_assignments_listing_and_edits(self):
        db = MockDB()
        aid = uuid4()
        course = {'id': str(self.cid), 'folder_id': str(self.fid), 'archived': False, 'can_manage': True}
        db.add_handler('SELECT 1 FROM learning.class_members', {'allowed': 1})

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course):
            # List assignments
            db.add_handler('SELECT * FROM learning.class_assignments WHERE class_id=', [
                {'id': str(aid), 'title': 'Assignment 1', 'due_at': None}
            ])
            db.add_handler('SELECT s.* FROM learning.class_submissions s JOIN', [])
            db.add_handler('SELECT s.assignment_id,count(*) AS count', [{'assignment_id': str(aid), 'count': 3}])
            res = classrooms.assignments(self.cid, user=self.user)
            self.assertEqual(len(res['items']), 1)
            self.assertEqual(res['items'][0]['submission_count'], 3)

            # Get single assignment
            db.add_handler('SELECT * FROM learning.class_assignments WHERE id=', {
                'id': str(aid), 'class_id': str(self.cid), 'title': 'Assignment 1', 'resource_type': 'none', 'resource_id': None
            })
            single = classrooms.get_assignment(self.cid, aid, user=self.user)
            self.assertEqual(single['title'], 'Assignment 1')

            # Edit assignment
            req_update = AssignmentUpdate(title="Updated Title", instructions="Instructions here", expected_revision=1, resource_type='none')
            db_assign = MockDB()
            db_assign.add_handler('SELECT * FROM learning.class_assignments WHERE id=', {
                'id': str(aid), 'class_id': str(self.cid), 'revision': 1
            })
            db_assign.add_handler('UPDATE learning.classes SET revision=', {})
            db_assign.add_handler('UPDATE learning.class_assignments SET', {'id': str(aid), 'title': 'Updated Title', 'revision': 2})
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_assign)):
                updated = classrooms.edit_assignment(self.cid, aid, req_update, user=self.user)
                self.assertEqual(updated['title'], 'Updated Title')

    def test_update_class_access_validation(self):
        # 1. Invalid group path (missing leading slash)
        req = ClassAccessInput(usernames=[], groups=['InvalidGroup'])
        with self.assertRaises(HTTPException) as ctx:
            classrooms.update_class_access(self.cid, req, user=self.user)
        self.assertEqual(ctx.exception.status_code, 422)

        # 2. Realm missing for Keycloak group
        req_grp = ClassAccessInput(usernames=[], groups=['/Valid/Group'])
        with patch('buddy_learning.classrooms.realm', return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.update_class_access(self.cid, req_grp, user=self.user)
            self.assertEqual(ctx.exception.status_code, 503)

        # 3. Nonexistent user
        db = MockDB()
        course = {'id': str(self.cid), 'folder_id': str(self.fid), 'archived': False, 'created_by': 'teacher1'}
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course):
            req_users = ClassAccessInput(usernames=['ghost_user'])
            with self.assertRaises(HTTPException) as ctx:
                classrooms.update_class_access(self.cid, req_users, user=self.user)
            self.assertEqual(ctx.exception.status_code, 422)
            self.assertIn("existing application users", ctx.exception.detail)

    def test_submit_and_feedback(self):
        db = MockDB()
        aid = uuid4()
        sub_id = uuid4()
        now = datetime.now(timezone.utc)
        course = {'id': str(self.cid), 'folder_id': str(self.fid), 'archived': False, 'can_manage': True}
        db.add_handler('SELECT 1 FROM learning.class_members', {'allowed': 1})

        # 1. Deadline passed and allow_late is False -> 409
        past = now - timedelta(days=2)
        past_assignment = {
            'id': str(aid), 'class_id': str(self.cid), 'due_at': past,
            'allow_late': False, 'revision': 1, 'title': 'A1'
        }
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.assignment', return_value=past_assignment):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.submit(self.cid, aid, Homework(text="My solution", expected_revision=1), user=self.user)
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertIn("deadline has passed", ctx.exception.detail)

        # 2. Already reviewed -> 409
        ok_assignment = {
            'id': str(aid), 'class_id': str(self.cid), 'due_at': None,
            'allow_late': True, 'revision': 1, 'title': 'A1',
            'instructions': 'Explain reasoning', 'section': 'Week 1',
            'resource_type': 'none', 'resource_id': None, 'resource_version': None,
            'required': True, 'minimum_score_percent': 0
        }
        db_reviewed = MockDB()
        db_reviewed.add_handler('SELECT 1 FROM learning.class_members', {'allowed': 1})
        db_reviewed.add_handler('SELECT * FROM learning.class_submissions WHERE assignment_id=', {
            'id': str(sub_id), 'assignment_id': str(aid), 'reviewed_at': now, 'revision': 1
        })
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_reviewed)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.assignment', return_value=ok_assignment):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.submit(self.cid, aid, Homework(text="My solution", expected_revision=1), user=self.user)
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertIn("Reviewed work cannot be overwritten", ctx.exception.detail)

        # 3. Revision mismatch -> 409
        db_rev = MockDB()
        db_rev.add_handler('SELECT 1 FROM learning.class_members', {'allowed': 1})
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_rev)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.assignment', return_value=ok_assignment):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.submit(self.cid, aid, Homework(text="My solution", expected_revision=99), user=self.user)
            self.assertEqual(ctx.exception.status_code, 409)

        # 4. Feedback: mark exceeds maximum -> ValidationError
        with self.assertRaises(ValidationError):
            Feedback(expected_revision=1, feedback="Good", mark=15, max_mark=10)

        # 5. Feedback: revision mismatch -> 409
        db_fb = MockDB()
        db_fb.add_handler('SELECT * FROM learning.class_assignments WHERE id=', ok_assignment)
        db_fb.add_handler('SELECT * FROM learning.class_submissions WHERE id=', {
            'id': str(sub_id), 'assignment_id': str(aid), 'revision': 1
        })
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_fb)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.feedback(self.cid, aid, sub_id, Feedback(expected_revision=2, feedback="Good", mark=8, max_mark=10), user=self.user)
            self.assertEqual(ctx.exception.status_code, 409)

        # 6. Feedback success
        db_fb_ok = MockDB()
        db_fb_ok.add_handler('SELECT * FROM learning.class_assignments WHERE id=', ok_assignment)
        db_fb_ok.add_handler('SELECT * FROM learning.class_submissions WHERE id=', {
            'id': str(sub_id), 'assignment_id': str(aid), 'revision': 1, 'username': 'synthetic-learner'
        })
        db_fb_ok.add_handler('UPDATE learning.class_submissions SET feedback=', {
            'id': str(sub_id), 'assignment_id': str(aid), 'feedback': 'Good job', 'mark': 9, 'max_mark': 10
        })
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_fb_ok)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course):
            fb_res = classrooms.feedback(self.cid, aid, sub_id, Feedback(expected_revision=1, feedback="Good job", mark=9, max_mark=10), user=self.user)
            self.assertEqual(fb_res['feedback'], 'Good job')

    def test_candidates_and_replace_members(self):
        db = MockDB()
        course = {'id': str(self.cid), 'folder_id': str(self.fid), 'archived': False, 'can_manage': True}
        db.add_handler('SELECT 1 FROM learning.class_members', {'allowed': 1})

        # 1. Directory too large -> 422
        huge_directory = [{'username': f'u{i}', 'is_admin': False, 'display_name': f'User {i}'} for i in range(1001)]
        db.add_handler('SELECT DISTINCT u.username', huge_directory)
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.candidates(self.cid, user=self.user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 2. replace_members: non-eligible user -> 422
        db_rep = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_rep)), \
             patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.eligible_users', return_value=[{'username': 'u1', 'display_name': 'U1'}]):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.replace_members(self.cid, Members(usernames=['u2_not_eligible']), user=self.user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 3. teacher_candidates: admin check and filter
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.admin', return_value=self.admin_user), \
             patch('buddy_learning.store.folder', return_value={}), \
             patch('buddy_learning.classrooms.eligible_users', return_value=[
                 {'username': 'u1', 'display_name': 'U1'},
                 {'username': 'u2', 'display_name': 'U2'}
             ]), \
             patch('buddy_learning.store.can_create', side_effect=lambda db, p: p['username'] == 'u1'):
            tc = classrooms.teacher_candidates(self.fid, user=self.admin_user)
            self.assertEqual(len(tc['items']), 1)
            self.assertEqual(tc['items'][0]['username'], 'u1')


# ==============================================================================
# Service Deep Tests
# ==============================================================================
class ServiceDeepTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.user = {'username': 'test_teacher', 'is_admin': False}
        self.admin_user = {'username': 'test_admin', 'is_admin': True}
        self.fid = UUID('11111111-2222-3333-4444-555555555555')
        self.bid = UUID('66666666-7777-8888-9999-000000000000')

    def test_same_origin(self):
        # Valid same origin
        req_ok = Request({'type': 'http', 'headers': [(b'origin', b'http://example.com'), (b'host', b'example.com')]})
        self.assertIsNone(service.same_origin(req_ok))

        # Missing origin is allowed
        req_no_origin = Request({'type': 'http', 'headers': [(b'host', b'example.com')]})
        self.assertIsNone(service.same_origin(req_no_origin))

        # Mismatched origin rejected
        req_cross = Request({'type': 'http', 'headers': [(b'origin', b'http://evil.com'), (b'host', b'example.com')]})
        with self.assertRaises(HTTPException) as ctx:
            service.same_origin(req_cross)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_admin_and_teacher_dependencies(self):
        # Admin
        with patch('buddy_learning.store.admin', return_value=self.admin_user):
            self.assertEqual(service.admin(self.admin_user), self.admin_user)

        # Teacher allowed
        db = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.can_create', return_value=True):
            self.assertEqual(service.teacher(self.user), self.user)

        # Teacher denied
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.can_create', return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                service.teacher(self.user)
            self.assertEqual(ctx.exception.status_code, 403)

    def test_clean_tags_and_derive_note_title(self):
        # Clean tags
        self.assertEqual(service._clean_tags(None), [])
        self.assertEqual(service._clean_tags([]), [])
        tags = ['#Python', 'python', '  AI  ', '', '#A' * 40]
        cleaned = service._clean_tags(tags)
        self.assertIn('python', cleaned)
        self.assertIn('ai', cleaned)
        self.assertEqual(len(cleaned), 3)

        # Derive note title
        self.assertEqual(service._derive_note_title("Custom Title", "Body text"), "Custom Title")
        self.assertEqual(service._derive_note_title("", "# Header Note\nSecond line"), "Header Note")
        self.assertEqual(service._derive_note_title(None, ""), "Class note")

    def test_class_notes_crud(self):
        db = MockDB()
        nid = uuid4()
        lid = uuid4()

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'name': 'Math Class'}):
            # List notes
            db.add_handler('SELECT n.id, n.folder_id', [{'id': str(nid), 'title': 'Note 1'}])
            res = service.list_class_notes(self.fid, user=self.user)
            self.assertEqual(len(res['items']), 1)

            # Create note - empty body
            with self.assertRaises(HTTPException) as ctx:
                service.create_class_note(self.fid, service.ClassNoteInput(body="   "), user=self.user)
            self.assertEqual(ctx.exception.status_code, 422)

            # Create note - lesson mismatch
            db.add_handler('SELECT folder_id, title, ordinal FROM learning.lessons', {'folder_id': str(uuid4()), 'title': 'L1', 'ordinal': 1})
            with self.assertRaises(HTTPException) as ctx:
                service.create_class_note(self.fid, service.ClassNoteInput(body="Note body", lesson_id=lid), user=self.user)
            self.assertEqual(ctx.exception.status_code, 422)

            # Create note - success
            db_create = MockDB()
            db_create.add_handler('SELECT folder_id, title, ordinal FROM learning.lessons', {'folder_id': str(self.fid), 'title': 'L1', 'ordinal': 1})
            db_create.add_handler('INSERT INTO learning.class_notes', {
                'id': str(nid), 'folder_id': str(self.fid), 'lesson_id': str(lid),
                'title': 'Note Title', 'body': 'Body text', 'color': 'butter',
                'tags': [], 'favorite': False, 'bob_note_id': None, 'created_at': None, 'updated_at': None
            })
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_create)):
                created = service.create_class_note(self.fid, service.ClassNoteInput(body="Body text", title="Note Title", lesson_id=lid), user=self.user)
                self.assertEqual(created['title'], 'Note Title')

            # Update note - not found
            db_empty = MockDB()
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_empty)):
                with self.assertRaises(HTTPException) as ctx:
                    service.update_class_note(nid, service.ClassNotePatch(body="New text"), user=self.user)
                self.assertEqual(ctx.exception.status_code, 404)

            # Delete note - success
            db_del = MockDB()
            db_del.add_handler('DELETE FROM learning.class_notes', {'id': str(nid), 'bob_note_id': None})
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_del)):
                del_res = service.delete_class_note(nid, user=self.user)
                self.assertEqual(del_res, {'deleted': True})

    def test_reader_notes_and_search(self):
        db = MockDB()
        parsed = {
            'chapters': [
                {'id': 'c1', 'title': 'Chapter 1'},
                {'id': 'c2', 'title': 'Chapter 2'}
            ],
            'assets': {
                'img.png': {'content': b'\x89PNG\r\n', 'media_type': 'image/png'}
            }
        }

        with patch('buddy_learning.service.authorized_book', return_value={'object_key': 'k1'}), \
             patch('buddy_learning.service.parsed_book', return_value=parsed), \
             patch('buddy_learning.service.chapter_plain', return_value='Synthetic machine learning text search content'):
            # Search
            res = service.search(self.bid, q="machine learning", user=self.user)
            self.assertEqual(len(res['items']), 2)
            self.assertIn("machine learning", res['items'][0]['excerpt'])

            # Asset success
            asset_res = service.asset(self.bid, path='img.png', user=self.user)
            self.assertEqual(asset_res.media_type, 'image/png')

            # Asset not found
            with self.assertRaises(HTTPException) as ctx:
                service.asset(self.bid, path='missing.png', user=self.user)
            self.assertEqual(ctx.exception.status_code, 404)

            # Progress - unknown chapter
            with self.assertRaises(HTTPException) as ctx:
                service.progress(self.bid, service.Progress(chapter_id='unknown_ch'), user=self.user)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_update_book_and_quiz_chapter(self):
        db = MockDB()
        qid = uuid4()
        lid = uuid4()

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)):
            # Update book chapter - lesson mismatch
            db.add_handler('SELECT folder_id FROM learning.lessons', {'folder_id': str(uuid4())})
            with patch('buddy_learning.store.book', return_value={'folder_id': str(self.fid), 'title': 'Book 1'}):
                with self.assertRaises(HTTPException) as ctx:
                    service.update_book_chapter(self.bid, service.BookChapterInput(lesson_id=lid), user=self.user)
                self.assertEqual(ctx.exception.status_code, 422)

            # Update quiz chapter - creator check
            with patch('buddy_learning.store.quiz', return_value={'folder_id': str(self.fid), 'created_by': 'other_user', 'draft': {}}), \
                 patch('buddy_learning.store.creator', side_effect=HTTPException(403, 'Forbidden')):
                with self.assertRaises(HTTPException) as ctx:
                    service.update_quiz_chapter(qid, service.QuizChapterInput(lesson_id=lid), user=self.user)
                self.assertEqual(ctx.exception.status_code, 403)

    async def test_translation_and_language_helpers(self):
        # _norm_lang
        self.assertEqual(service._norm_lang('en-US'), 'en')
        self.assertEqual(service._norm_lang('el_GR'), 'el')
        self.assertEqual(service._norm_lang('hi'), 'hi')
        self.assertEqual(service._norm_lang('fr'), 'en')

        # Translate content size limit
        req_huge = service.TranslateContentRequest(
            kind='quiz', target_language='el', payload={'text': 'A' * 66000}
        )
        with self.assertRaises(HTTPException) as ctx:
            await service.translate_content(req_huge, user=self.user)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_results_csv_formula_sanitization(self):
        db = MockDB()
        qid = uuid4()
        row_injection = {
            'display_name': '=SUM(1,2)',
            'username': '+user_cmd',
            'quiz_version': 1,
            'submitted_at': datetime.now(timezone.utc),
            'score': 10,
            'max_score': 10,
            'pending_manual': False,
            'answers': {},
            'grades': {}
        }
        with patch('buddy_learning.service.results', return_value={'items': [row_injection]}):
            response = service.results_csv(qid, user=self.user)
            csv_text = response.body.decode('utf-8')
            # Check formula markers are escaped with leading quote
            self.assertIn("'=SUM(1,2)", csv_text)
            self.assertIn("'+user_cmd", csv_text)

    async def test_ai_draft_endpoints(self):
        lid = uuid4()
        # 1. ai_draft BudgetExceeded -> 429
        with patch('buddy_learning.service.authorized_book', return_value={'object_key': 'k1', 'folder_id': str(self.fid)}), \
             patch('buddy_learning.service.parsed_book', return_value={}), \
             patch('buddy_learning.quiz_ai.create_draft', side_effect=BudgetExceeded("Budget out")):
            with self.assertRaises(HTTPException) as ctx:
                await service.ai_draft(self.bid, service.DraftRequest(), user=self.user)
            self.assertEqual(ctx.exception.status_code, 429)

        # 2. ai_draft TimeoutError -> 504
        with patch('buddy_learning.service.authorized_book', return_value={'object_key': 'k1', 'folder_id': str(self.fid)}), \
             patch('buddy_learning.service.parsed_book', return_value={}), \
             patch('buddy_learning.quiz_ai.create_draft', side_effect=TimeoutError()):
            with self.assertRaises(HTTPException) as ctx:
                await service.ai_draft(self.bid, service.DraftRequest(), user=self.user)
            self.assertEqual(ctx.exception.status_code, 504)

        # 3. ai_draft ValueError -> 502
        with patch('buddy_learning.service.authorized_book', return_value={'object_key': 'k1', 'folder_id': str(self.fid)}), \
             patch('buddy_learning.service.parsed_book', return_value={}), \
             patch('buddy_learning.quiz_ai.create_draft', side_effect=ValueError()):
            with self.assertRaises(HTTPException) as ctx:
                await service.ai_draft(self.bid, service.DraftRequest(), user=self.user)
            self.assertEqual(ctx.exception.status_code, 502)

        # 4. ai_lesson_draft no excerpts -> 422
        db = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.lessons.lookup', return_value=({'draft': {}, 'published': None, 'folder_id': str(self.fid)}, True)), \
             patch('buddy_learning.lessons.lesson_plain_excerpts', return_value=([], False)):
            with self.assertRaises(HTTPException) as ctx:
                await service.ai_lesson_draft(lid, service.DraftRequest(), user=self.user)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_quiz_lifecycle_and_grading(self):
        db = MockDB()
        qid = uuid4()
        sub_id = uuid4()
        q_spec = QuizInput(
            title="Quiz Title",
            questions=[QuizQuestion(id="q1", type="text", question="Explain?", answer="Reference", rubric="Rubric", points=5, explanation="Exp", study_topic="Top", reading="R1")]
        )

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(self.fid), 'name': 'Folder'}), \
             patch('buddy_learning.store.quiz', return_value={'id': str(qid), 'folder_id': str(self.fid), 'draft': q_spec.model_dump(), 'created_by': self.user['username'], 'status': 'draft'}):
            # Create quiz
            db.add_handler('INSERT INTO learning.quizzes', {'id': str(qid), 'folder_id': str(self.fid), 'draft': q_spec.model_dump(), 'published': None, 'status': 'draft', 'created_by': self.user['username']})
            with patch('buddy_learning.store.can_create', return_value=True):
                created = service.create_quiz(self.fid, q_spec, user=self.user)
                self.assertEqual(created['status'], 'draft')

            # Publish quiz
            db.add_handler('UPDATE learning.quizzes SET published=draft', {'id': str(qid), 'status': 'published', 'version': 2})
            pub = service.publish(qid, user=self.user)
            self.assertEqual(pub['published'], True)
            self.assertEqual(pub['version'], 2)

            # Close quiz with draft status raises 409
            with patch('buddy_learning.store.quiz', return_value={'id': str(qid), 'status': 'draft', 'created_by': self.user['username']}):
                with self.assertRaises(HTTPException) as ctx:
                    service.close(qid, user=self.user)
                self.assertEqual(ctx.exception.status_code, 409)

            # Close quiz success
            with patch('buddy_learning.store.quiz', return_value={'id': str(qid), 'status': 'published', 'created_by': self.user['username']}):
                db.add_handler('UPDATE learning.quizzes SET status=', {})
                closed = service.close(qid, user=self.user)
                self.assertEqual(closed['closed'], True)

            # Manual grade - submission not found -> 404
            db_empty = MockDB()
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_empty)):
                with self.assertRaises(HTTPException) as ctx:
                    service.manual_grade(sub_id, ManualGrades(grades={'q1': ManualGrade(score=4, feedback='Good')}), user=self.user)
                self.assertEqual(ctx.exception.status_code, 404)

    def test_folders_and_contents_and_me(self):
        db = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)):
            # 1. me()
            with patch('buddy_learning.store.can_create', return_value=True):
                me_res = service.me(user=self.user)
                self.assertEqual(me_res['username'], self.user['username'])
                self.assertTrue(me_res['can_create_quizzes'])

            # 2. users()
            db.add_handler('SELECT DISTINCT u.username', [{'username': 'u1', 'display_name': 'User 1'}])
            u_res = service.users(user=self.admin_user)
            self.assertEqual(len(u_res['items']), 1)

            # 3. groups() with no realm
            with patch('app.keycloak_groups.realm', return_value=None):
                g_res = service.groups(user=self.admin_user)
                self.assertEqual(g_res['items'], [])

            # 4. folders() and _enrich_folders
            with patch('buddy_learning.store.visible_folders', return_value=[{'id': str(self.fid), 'name': 'F1'}]), \
                 patch('buddy_learning.service._enrich_folders', return_value=[{'id': str(self.fid), 'name': 'F1', 'book_count': 1}]):
                f_res = service.folders(user=self.user)
                self.assertEqual(len(f_res['items']), 1)

            # 5. create_folder()
            req_f = service.FolderInput(name="New Folder")
            db.add_handler('INSERT INTO learning.folders', {'id': str(self.fid), 'name': 'New Folder', 'parent_id': None})
            created_f = service.create_folder(req_f, user=self.admin_user)
            self.assertEqual(created_f['name'], 'New Folder')

            # 6. rename_folder()
            req_rename = service.FolderInput(name="Renamed Folder")
            with patch('buddy_learning.store.folder', return_value={'id': str(self.fid), 'name': 'Old Name'}):
                db.add_handler('UPDATE learning.folders SET name=', {'id': str(self.fid), 'name': 'Renamed Folder', 'parent_id': None})
                renamed_f = service.rename_folder(self.fid, req_rename, user=self.admin_user)
                self.assertEqual(renamed_f['name'], 'Renamed Folder')

            # 7. contents()
            db.add_handler('SELECT id,title,author,extension FROM learning.books', [{'id': str(uuid4()), 'title': 'Book 1', 'author': 'A1', 'extension': 'epub'}])
            db.add_handler('FROM learning.quizzes q WHERE q.folder_id=', [])
            db.add_handler('FROM learning.lessons', [])
            with patch('buddy_learning.store.folder', return_value={'name': 'F1'}), \
                 patch('buddy_learning.store.can_create', return_value=True):
                c_res = service.contents(self.fid, user=self.user)
                self.assertEqual(len(c_res['books']), 1)

    def test_book_reader_views(self):
        parsed = {
            'chapters': [{'id': 'ch1', 'title': 'Ch 1'}],
            'assets': {}
        }
        with patch('buddy_learning.service.authorized_book', return_value={'object_key': 'k1', 'title': 'BookTitle', 'author': 'Author', 'filename': 'book.epub'}), \
             patch('buddy_learning.service.parsed_book', return_value=parsed):
            # book_info
            db = MockDB()
            db.add_handler('SELECT data FROM learning.progress', {'data': {'page': 5}})
            with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)):
                info = service.book_info(self.bid, user=self.user)
                self.assertEqual(info['title'], 'BookTitle')
                self.assertEqual(info['progress']['page'], 5)

            # download_source
            with patch('buddy_learning.service.object_bytes', return_value=b'binary_epub_data'):
                dl = service.download_source(self.bid, user=self.user)
                self.assertEqual(dl.body, b'binary_epub_data')

            # chapter render success & failure
            with patch('buddy_learning.service.render_chapter', return_value='<html>Chapter</html>'):
                ch = service.chapter(self.bid, 'ch1', user=self.user)
                self.assertIn("<html>Chapter</html>", ch.body.decode())

            with patch('buddy_learning.service.render_chapter', side_effect=KeyError()):
                with self.assertRaises(HTTPException) as ctx:
                    service.chapter(self.bid, 'ch_missing', user=self.user)
                self.assertEqual(ctx.exception.status_code, 404)

            # chapter_plain helper
            html_content = "<div><p>Hello <b>World</b>!</p></div>"
            with patch('buddy_learning.service.render_chapter', return_value=html_content):
                plain = service.chapter_plain(parsed, 'ch1')
                self.assertIn("World", plain)

    async def test_chat_learning_coach(self):
        qid = uuid4()
        from buddy_learning.assistant import ChatReply
        chat_req = service.ChatRequest(message="Hello coach", quiz_id=qid)

        db = MockDB()
        quiz_data = {
            'id': str(qid), 'folder_id': str(self.fid), 'created_by': self.user['username'],
            'status': 'draft', 'draft': {'title': 'Q1', 'questions': []}, 'published': None
        }
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(self.fid), 'name': 'Folder'}), \
             patch('buddy_learning.store.can_create', return_value=True), \
             patch('buddy_learning.store.quiz', return_value=quiz_data), \
             patch('buddy_learning.assistant.respond', new_callable=AsyncMock) as mock_respond:
            mock_respond.return_value = ChatReply(reply="Coach feedback here")
            res = await service.chat(self.fid, chat_req, user=self.user)
            self.assertEqual(res['reply'], "Coach feedback here")

    def test_create_app_initialization(self):
        app = service.create_app()
        self.assertIsInstance(app, FastAPI)

    async def test_upload_book_and_validations(self):
        fid = uuid4()
        user = {'username': 'alice', 'roles': ['learning_admin']}
        db = MockDB()

        # 1. Target chapter not belonging to this class -> 422
        lid = uuid4()
        db.add_handler('SELECT folder_id FROM learning.lessons', {'folder_id': str(uuid4())})
        upload_file_mock = MagicMock()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(fid)}), \
             patch.object(service, '_is_real_db', return_value=True):
            with self.assertRaises(HTTPException) as ctx:
                await service.upload_book(fid, upload_file_mock, lesson_id=lid, user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 2. File too large (> 50MB) -> 413
        large_file = MagicMock()
        large_file.read = AsyncMock(side_effect=[b'x' * (1024 * 1024)] * 51)
        large_file.close = AsyncMock()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(fid)}), \
             patch.object(service, '_is_real_db', return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                await service.upload_book(fid, large_file, lesson_id=None, user=user)
            self.assertEqual(ctx.exception.status_code, 413)

        # 3. Document parse ValueError -> 422
        valid_file = MagicMock()
        valid_file.read = AsyncMock(side_effect=[b'content', b''])
        valid_file.close = AsyncMock()
        valid_file.filename = 'book.pdf'
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(fid)}), \
             patch.object(service, '_is_real_db', return_value=False), \
             patch('buddy_learning.service.parse_document', side_effect=ValueError('Corrupt PDF')):
            with self.assertRaises(HTTPException) as ctx:
                await service.upload_book(fid, valid_file, lesson_id=None, user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 4. Successful upload and S3 put
        valid_file_ok = MagicMock()
        valid_file_ok.read = AsyncMock(side_effect=[b'valid pdf bytes', b''])
        valid_file_ok.close = AsyncMock()
        valid_file_ok.filename = 'test_book.pdf'
        s3_mock = MagicMock()
        row_book = {'id': str(uuid4()), 'title': 'Test Book', 'author': 'Author', 'extension': 'pdf'}
        db.add_handler('INSERT INTO learning.books', row_book)

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(fid)}), \
             patch.object(service, '_is_real_db', return_value=False), \
             patch('buddy_learning.service.parse_document', return_value={'title': 'Test Book', 'author': 'Author'}), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'my-bucket'}), \
             patch.object(service, 's3', return_value=s3_mock):
            res = await service.upload_book(fid, valid_file_ok, lesson_id=None, user=user)
            self.assertEqual(res['title'], 'Test Book')
            s3_mock.put_object.assert_called_once()

    async def test_import_office_book(self):
        fid = uuid4()
        user = {'username': 'alice', 'roles': ['learning_admin']}
        db = MockDB()
        req = service.OfficeImport(file_id=uuid4())
        mock_http_req = MagicMock()

        # Parse error -> 422
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(fid)}), \
             patch('buddy_learning.office_import.read_file', AsyncMock(return_value={'raw': b'raw', 'name': 'bad.docx'})), \
             patch('buddy_learning.service.parse_document', side_effect=ValueError('Invalid docx')):
            with self.assertRaises(HTTPException) as ctx:
                await service.import_office(fid, req, mock_http_req, user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # Successful office import
        s3_mock = MagicMock()
        row_book = {'id': str(uuid4()), 'title': 'Office Doc', 'author': 'Office Author', 'extension': 'docx'}
        db.add_handler('INSERT INTO learning.books', row_book)

        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db)), \
             patch('buddy_learning.store.folder', return_value={'id': str(fid)}), \
             patch('buddy_learning.office_import.read_file', AsyncMock(return_value={'raw': b'raw bytes', 'name': 'file.docx'})), \
             patch('buddy_learning.service.parse_document', return_value={'title': 'Office Doc', 'author': 'Office Author'}), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'my-bucket'}), \
             patch.object(service, 's3', return_value=s3_mock):
            res = await service.import_office(fid, req, mock_http_req, user=user)
            self.assertEqual(res['title'], 'Office Doc')
            s3_mock.put_object.assert_called_once()

    async def test_suggest_submission_grades_edge_cases(self):
        sub_id = uuid4()
        user = {'username': 'teacher1', 'roles': ['teacher']}

        # 1. Submission not found -> 404
        db_empty = MockDB()
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_empty)):
            with self.assertRaises(HTTPException) as ctx:
                await service.suggest_grading(sub_id, service.LanguageRequest(), user=user)
            self.assertEqual(ctx.exception.status_code, 404)

        # 2. No written answers -> 422
        sub_no_written = {
            'quiz_id': uuid4(), 'questions': [{'id': 'q1', 'type': 'choice'}], 'answers': {'q1': 0}
        }
        db_no_written = MockDB()
        db_no_written.add_handler('SELECT quiz_id,questions,answers FROM learning.submissions', sub_no_written)
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_no_written)), \
             patch.object(service, 'review_quiz'):
            with self.assertRaises(HTTPException) as ctx:
                await service.suggest_grading(sub_id, service.LanguageRequest(), user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 3. Payload too long (> 60000) -> 422
        sub_long = {
            'quiz_id': uuid4(),
            'questions': [{'id': 'q1', 'type': 'text'}],
            'answers': {'q1': 'a' * 65000}
        }
        db_long = MockDB()
        db_long.add_handler('SELECT quiz_id,questions,answers FROM learning.submissions', sub_long)
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_long)), \
             patch.object(service, 'review_quiz'):
            with self.assertRaises(HTTPException) as ctx:
                await service.suggest_grading(sub_id, service.LanguageRequest(), user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 4. TimeoutError -> 504
        sub_valid = {
            'quiz_id': uuid4(),
            'questions': [{'id': 'q1', 'type': 'text'}],
            'answers': {'q1': 'Short answer'}
        }
        db_valid = MockDB()
        db_valid.add_handler('SELECT quiz_id,questions,answers FROM learning.submissions', sub_valid)
        with patch('app.job_queue._connect', side_effect=lambda: DBContext(db_valid)), \
             patch.object(service, 'review_quiz'), \
             patch('buddy_learning.quiz_ai.suggest_grades', side_effect=TimeoutError()):
            with self.assertRaises(HTTPException) as ctx:
                await service.suggest_grading(sub_id, service.LanguageRequest(), user=user)
            self.assertEqual(ctx.exception.status_code, 504)

    async def test_translate_content_endpoint(self):
        user = {'username': 'teacher1', 'roles': ['teacher']}

        # 1. Payload too large -> 422
        req_large = service.TranslateContentRequest(
            kind='quiz', target_language='el', payload={'data': 'x' * 70000}
        )
        with self.assertRaises(HTTPException) as ctx:
            await service.translate_content(req_large, user=user)
        self.assertEqual(ctx.exception.status_code, 422)

        # 2. Completion returns invalid json -> 502
        req_valid = service.TranslateContentRequest(
            kind='quiz', target_language='el', payload={'title': 'Quiz'}
        )
        with patch('buddy_learning.assistant.completion', AsyncMock(return_value='invalid json')):
            with self.assertRaises(HTTPException) as ctx:
                await service.translate_content(req_valid, user=user)
            self.assertEqual(ctx.exception.status_code, 502)

        # 3. Successful translation
        with patch('buddy_learning.assistant.completion', AsyncMock(return_value='{"title": "Κουίζ"}')):
            res = await service.translate_content(req_valid, user=user)
            self.assertEqual(res['language'], 'el')
            self.assertEqual(res['translated'], {'title': 'Κουίζ'})

    async def test_populate_quiz_3_languages_helper(self):
        spec = QuizInput(
            title='Sample Quiz',
            questions=[QuizQuestion(id='q1', type='text', question='What is ACP?', answer='Agent Control Protocol', rubric='Must mention Agent Control Protocol', points=1)]
        )
        with patch('buddy_learning.service._translate_json_payload', AsyncMock(return_value={'title': 'Translated', 'questions': [{'id': 'q1', 'type': 'text', 'question': 'T', 'answer': 'A', 'rubric': 'Marking rubric', 'points': 1}]})):
            populated = await service._populate_quiz_3_languages(spec, 'en', 'alice')
            self.assertEqual(populated.language, 'en')
            self.assertIn('el', populated.translations)
            self.assertIn('hi', populated.translations)


if __name__ == '__main__':
    unittest.main()
