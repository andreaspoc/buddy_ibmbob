"""Deep coverage unit tests for app.main and buddy_learning course_completion & service.

Hermetic tests: no live external network, no production DB, no real email or telemetry.
Adheres strictly to the Zero Fake Data Policy using synthetic test doubles.
"""
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, Mock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
PLUGINS_LEARNING = ROOT / 'plugins' / 'learning'

for p in (str(ROOT), str(PLUGINS_LEARNING)):
    if p not in sys.path:
        sys.path.insert(0, p)

from app import main
from app.auth import current_user
from buddy_learning import course_completion, service, store
from buddy_learning.course_completion import (
    Approval, ClaimCertificate, Revocation, _certificate_summary, _digest,
    _effective_requirements, _roster, _smtp_status, _state,
    check_and_issue_for_folder, completion_evidence, deliver_certificate_email,
)
from buddy_learning.quizzes import QuizInput, QuizQuestion


class Cursor:
    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = rows if rows is not None else ([row] if row is not None else [])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class MockDB:
    """Mock database connection with substring query routing."""
    def __init__(self, is_real=False):
        self.queries = []
        self.handlers = []
        if is_real:
            self.info = SimpleNamespace(backend_pid=12345)

    def add_handler(self, matcher, result):
        self.handlers.append((matcher, result))

    def execute(self, sql, params=()):
        compact = ' '.join(sql.split())
        self.queries.append((compact, params))
        for matcher, result in self.handlers:
            matched = matcher(compact, params) if callable(matcher) else matcher in compact
            if matched:
                res = result(compact, params) if callable(result) else result
                if isinstance(res, Cursor):
                    return res
                if isinstance(res, list):
                    return Cursor(rows=res)
                return Cursor(row=res)
        return Cursor(row=None, rows=[])

    def commit(self):
        pass

    def rollback(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class MainMiddlewareAndSecurityTests(unittest.TestCase):
    """Test custom middleware, browser security, and global exception mapping."""

    def setUp(self):
        self.user = {'username': 'alice', 'is_admin': True}

        async def identity(request=None):
            if self.user is None:
                raise HTTPException(401, 'Sign in required')
            return self.user

        self.user_patch = patch('app.auth.current_user', identity)
        self.user_patch.start()
        main.app.dependency_overrides[main.current_user] = identity
        main.app.middleware_stack = None
        self.client = TestClient(main.app)

    def tearDown(self):
        self.user_patch.stop()
        main.app.dependency_overrides.clear()
        main.app.middleware_stack = None
        self.client.close()

    def test_browser_security_headers_present(self):
        resp = self.client.get('/health')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertIn("frame-ancestors 'self'", resp.headers.get('Content-Security-Policy', ''))

    def test_browser_security_blocks_ambient_cookie_without_origin(self):
        self.client.cookies.set('bob_ui_session', 'token123')
        resp = self.client.post('/skills', json={'name': 'test-skill', 'description': 'desc 12345', 'instructions': 'inst'})
        self.assertEqual(resp.status_code, 403)
        self.assertIn('Same-origin', resp.text)

    def test_browser_security_allows_matching_origin(self):
        self.client.cookies.set('bob_ui_session', 'token123')
        with patch('app.main.create_skill', return_value={'name': 'skill-one', 'description': 'desc 12345'}):
            resp = self.client.post(
                '/skills',
                headers={'origin': 'http://testserver'},
                json={'name': 'skill-one', 'description': 'desc 12345', 'instructions': 'inst'}
            )
            self.assertEqual(resp.status_code, 201)

    def test_request_validation_error_returns_422(self):
        # Missing required prompt in StreamRequest
        resp = self.client.post('/chat/stream', headers={'origin': 'http://testserver'}, json={})
        self.assertEqual(resp.status_code, 422)

        # Invalid client_timezone in StreamRequest
        resp = self.client.post(
            '/chat/stream',
            headers={'origin': 'http://testserver'},
            json={'prompt': 'hello', 'client_timezone': 'Nonexistent/Timezone_1234'}
        )
        self.assertEqual(resp.status_code, 422)

        # Invalid UI language
        resp = self.client.post(
            '/chat/stream',
            headers={'origin': 'http://testserver'},
            json={'prompt': 'hello', 'ui_language': 'de'}
        )
        self.assertEqual(resp.status_code, 422)


class MainValidatorsAndEndpointsTests(unittest.TestCase):
    """Test healthcheck, readiness, agent-card, ask, and a2a endpoints in app/main.py."""

    def setUp(self):
        self.user = {'username': 'alice', 'is_admin': True}

        async def identity(request=None):
            if self.user is None:
                raise HTTPException(401, 'Sign in required')
            return self.user

        self.user_patch = patch('app.auth.current_user', identity)
        self.user_main_patch = patch('app.main.current_user', identity)
        self.user_patch.start()
        self.user_main_patch.start()
        main.app.dependency_overrides[main.current_user] = identity
        main.app.middleware_stack = None
        self.client = TestClient(main.app)

    def tearDown(self):
        self.user_patch.stop()
        self.user_main_patch.stop()
        main.app.dependency_overrides.clear()
        main.app.middleware_stack = None
        self.client.close()

    def test_health_and_readiness(self):
        # /health probe via HTTP
        resp = self.client.get('/health')
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['ok'])

        # Direct health endpoint call
        import asyncio
        body = asyncio.run(main.health())
        self.assertTrue(body['ok'])
        self.assertIn('workspace', body)

        # /ready success
        with patch('app.auth._connect', return_value=MockDB()):
            resp_ready = self.client.get('/ready')
            self.assertEqual(resp_ready.status_code, 200)
            self.assertEqual(resp_ready.json(), {'ok': True})

        # /ready failure -> 503
        with patch('app.auth._connect', side_effect=Exception('DB offline')):
            resp_fail = self.client.get('/ready')
            self.assertEqual(resp_fail.status_code, 503)

    def test_agent_cards(self):
        resp1 = self.client.get('/.well-known/agent-card.json')
        self.assertEqual(resp1.status_code, 200)
        self.assertIn('name', resp1.json())

        resp2 = self.client.get('/.well-known/agent.json')
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(resp1.json(), resp2.json())

    def test_ask_endpoint_success_and_error(self):
        # Success
        mock_res = {'text': 'Answer text', 'session_id': 'sess-1', 'prompt_response': 'ok', 'events': []}
        with patch('app.postgres_storage.direct_workspace') as mock_ws, \
             patch('app.main.personalize_prompt', side_effect=lambda p, u: p), \
             patch.object(main.bridge, 'ask', AsyncMock(return_value=mock_res)):
            mock_ws.return_value.__enter__.return_value = (Path('/tmp'), Path('/tmp/ws'))
            resp = self.client.post('/ask', headers={'origin': 'http://testserver'}, json={'prompt': 'What is ACP?'})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()['response'], 'Answer text')

        # Error -> 500
        with patch('app.postgres_storage.direct_workspace') as mock_ws, \
             patch('app.main.personalize_prompt', side_effect=lambda p, u: p), \
             patch.object(main.bridge, 'ask', AsyncMock(side_effect=RuntimeError('Bridge offline'))):
            mock_ws.return_value.__enter__.return_value = (Path('/tmp'), Path('/tmp/ws'))
            resp_err = self.client.post('/ask', headers={'origin': 'http://testserver'}, json={'prompt': 'What is ACP?'})
            self.assertEqual(resp_err.status_code, 500)

    def test_a2a_endpoint_jsonrpc_errors_and_success(self):
        # 1. Invalid jsonrpc version
        resp1 = self.client.post('/a2a', headers={'origin': 'http://testserver'}, json={'jsonrpc': '1.0', 'id': '1'})
        self.assertEqual(resp1.json()['error']['code'], -32600)

        # 2. Authentication failure
        self.user = None
        resp2 = self.client.post('/a2a', headers={'origin': 'http://testserver'}, json={'jsonrpc': '2.0', 'id': '2'})
        self.assertEqual(resp2.json()['error']['code'], -32000)

        # Restore user
        self.user = {'username': 'alice', 'is_admin': True}

        # 3. Method not found
        resp3 = self.client.post('/a2a', headers={'origin': 'http://testserver'}, json={'jsonrpc': '2.0', 'id': '3', 'method': 'invalid_method'})
        self.assertEqual(resp3.json()['error']['code'], -32601)

        # 4. Prompt extraction error
        resp4 = self.client.post('/a2a', headers={'origin': 'http://testserver'}, json={'jsonrpc': '2.0', 'id': '4', 'method': 'message/send', 'params': {}})
        self.assertEqual(resp4.json()['error']['code'], -32602)

        # 5. Bridge execution error
        with patch('app.postgres_storage.direct_workspace') as mock_ws, \
             patch('app.main.personalize_prompt', side_effect=lambda p, u: p), \
             patch.object(main.bridge, 'ask', AsyncMock(side_effect=Exception('A2A backend error'))):
            mock_ws.return_value.__enter__.return_value = (Path('/tmp'), Path('/tmp/ws'))
            resp5 = self.client.post(
                '/a2a',
                headers={'origin': 'http://testserver'},
                json={'jsonrpc': '2.0', 'id': '5', 'method': 'message/send', 'params': {'prompt': 'Hi'}}
            )
            self.assertEqual(resp5.json()['error']['code'], -32000)

        # 6. Success
        mock_result = {'text': 'A2A response', 'session_id': 'sess-a2a'}
        with patch('app.postgres_storage.direct_workspace') as mock_ws, \
             patch('app.main.personalize_prompt', side_effect=lambda p, u: p), \
             patch.object(main.bridge, 'ask', AsyncMock(return_value=mock_result)):
            mock_ws.return_value.__enter__.return_value = (Path('/tmp'), Path('/tmp/ws'))
            resp6 = self.client.post(
                '/a2a',
                headers={'origin': 'http://testserver'},
                json={'jsonrpc': '2.0', 'id': '6', 'method': 'SendMessage', 'params': {'prompt': 'Hello agent'}}
            )
            self.assertEqual(resp6.status_code, 200)
            self.assertEqual(resp6.json()['result']['parts'][0]['text'], 'A2A response')

    def test_chat_stream_validation_edges(self):
        # 1. Voice mode with conflicting options -> 422
        resp = self.client.post(
            '/chat/stream',
            headers={'origin': 'http://testserver'},
            json={'prompt': 'hi', 'voice_mode': True, 'agent_name': 'agent1'}
        )
        self.assertEqual(resp.status_code, 422)
        self.assertIn('Voice discussion', resp.json()['detail'])

        # 2. Idempotency header mismatch -> 422
        with patch('app.sessions.workspace_for', return_value=Path('/tmp')):
            resp_idem = self.client.post(
                '/chat/stream',
                headers={'origin': 'http://testserver', 'idempotency-key': 'key-header'},
                json={'prompt': 'hi', 'idempotency_key': 'key-body'}
            )
            self.assertEqual(resp_idem.status_code, 422)

        # 3. Conversation not found -> 404
        with patch('app.main.workspace_for', side_effect=FileNotFoundError()):
            resp_404 = self.client.post(
                '/chat/stream',
                headers={'origin': 'http://testserver'},
                json={'prompt': 'hi'}
            )
            self.assertEqual(resp_404.status_code, 404)


class LearningCourseCompletionDeepTests(unittest.TestCase):
    """Deep hermetic unit tests for course completion and certificate workflows."""

    def test_schema_execution(self):
        db = MockDB()
        course_completion.schema(db)
        self.assertGreaterEqual(len(db.queries), 5)

    def test_models_validation(self):
        # Approval model
        valid_digest = 'a' * 64
        appr = Approval(expected_revision=1, evidence_digest=valid_digest, recipient_name='Alice Smith')
        self.assertEqual(appr.recipient_name, 'Alice Smith')

        with self.assertRaises(ValueError):
            Approval(expected_revision=1, evidence_digest=valid_digest, recipient_name='   ')

        with self.assertRaises(ValueError):
            Approval(expected_revision=1, evidence_digest='invalid_digest', recipient_name='Alice')

        # Revocation model
        rev = Revocation(reason='Course material updated')
        self.assertEqual(rev.reason, 'Course material updated')

        with self.assertRaises(ValueError):
            Revocation(reason='   ')

        # ClaimCertificate model
        claim = ClaimCertificate(recipient_name='Bob')
        self.assertEqual(claim.recipient_name, 'Bob')

    def test_completion_evidence_multi_kind_and_thresholds(self):
        assignments = [
            {'id': 'a1', 'title': 'L1', 'revision': 1, 'resource_type': 'lesson', 'required': True},
            {'id': 'a2', 'title': 'Q1', 'revision': 1, 'resource_type': 'quiz', 'required': True, 'minimum_score_percent': 80},
            {'id': 'a3', 'title': 'H1', 'revision': 2, 'resource_type': 'homework', 'required': True},
            {'id': 'a4', 'title': 'Opt', 'revision': 1, 'resource_type': 'lesson', 'required': False},
        ]

        # Lesson incomplete, quiz below threshold, homework unreviewed
        lessons = {'a1': {'completed': False}}
        quizzes = {'a2': {'id': 'q1', 'score': 7, 'max_score': 10, 'pending_manual': False, 'grades': {}}}
        homework = {'a3': {'id': 'h1', 'assignment_revision': 2, 'reviewed_at': None}}

        ev1 = completion_evidence(assignments, lessons, quizzes, homework)
        self.assertEqual(len(ev1), 3)  # a4 skipped
        self.assertFalse(all(e['completed'] for e in ev1))
        self.assertEqual(ev1[1]['status'], 'Required quiz score not reached')

        # All completed
        lessons_ok = {'a1': {'completed': True, 'updated_at': '2026-01-01'}}
        quizzes_ok = {'a2': {'id': 'sub1', 'score': 9, 'max_score': 10, 'pending_manual': False, 'grades': {'q': 1}}}
        homework_ok = {'a3': {'id': 'sub2', 'assignment_revision': 2, 'reviewed_at': '2026-01-01', 'revision': 1}}

        ev2 = completion_evidence(assignments, lessons_ok, quizzes_ok, homework_ok)
        self.assertTrue(all(e['completed'] for e in ev2))

    def test_deliver_certificate_email_states(self):
        cert = {
            'id': str(uuid4()), 'username': 'alice@example.com', 'course_title': 'Python 101',
            'recipient_name': 'Alice', 'instructor_name': 'Teacher',
            'issued_at': datetime.now(timezone.utc), 'version': 1
        }

        # 1. Mock DB returns cert_row immediately
        mock_db = MockDB()
        self.assertEqual(deliver_certificate_email(mock_db, cert), cert)

        # 2. Real DB but SMTP not configured -> email_status = pending_smtp
        real_db = MockDB(is_real=True)
        with patch.object(course_completion, '_smtp_status', return_value=(False, {})):
            res_pending = deliver_certificate_email(real_db, cert)
            self.assertEqual(res_pending['email_status'], 'pending_smtp')

        # 3. SMTP enabled but no email address on profile -> email_status = no_email
        cert_no_email = {**cert, 'username': 'no_email_user'}
        real_db_no_email = MockDB(is_real=True)
        with patch.object(course_completion, '_smtp_status', return_value=(True, {'enabled': True})):
            res_no_email = deliver_certificate_email(real_db_no_email, cert_no_email)
            self.assertEqual(res_no_email['email_status'], 'no_email')

        # 4. SMTP enabled, email sent successfully
        real_db_sent = MockDB(is_real=True)
        with patch.object(course_completion, '_smtp_status', return_value=(True, {'enabled': True, 'host': 'smtp.test', 'from_address': 'admin@test'})), \
             patch('anyio.from_thread.run', return_value=b'%PDF-fake'), \
             patch('app.smtp_settings.send_message') as mock_send:
            res_sent = deliver_certificate_email(real_db_sent, cert)
            self.assertEqual(res_sent['email_status'], 'sent')
            mock_send.assert_called_once()

        # 5. SMTP send failure -> email_status = failed
        real_db_err = MockDB(is_real=True)
        with patch.object(course_completion, '_smtp_status', return_value=(True, {'enabled': True, 'host': 'smtp.test', 'from_address': 'admin@test'})), \
             patch('anyio.from_thread.run', return_value=b'%PDF-fake'), \
             patch('app.smtp_settings.send_message', side_effect=RuntimeError('SMTP down')):
            res_err = deliver_certificate_email(real_db_err, cert)
            self.assertEqual(res_err['email_status'], 'failed')
            self.assertIn('SMTP down', res_err['email_error'])

    def test_effective_requirements_and_state(self):
        course = {'id': uuid4(), 'folder_id': uuid4(), 'revision': 1, 'title': 'Course A'}

        # Mock DB returns assignments from class_assignments
        db_mock = MockDB()
        db_mock.add_handler('SELECT * FROM learning.class_assignments', [
            {'id': 'a1', 'title': 'L1', 'revision': 1, 'resource_type': 'lesson', 'required': True}
        ])
        reqs = _effective_requirements(db_mock, course)
        self.assertEqual(len(reqs), 1)

        # Real DB includes direct published lessons and quizzes
        db_real = MockDB(is_real=True)
        db_real.add_handler('SELECT * FROM learning.class_assignments', [])
        db_real.add_handler('SELECT id, COALESCE(published->>\'title\', title) AS title, version FROM learning.lessons', [
            {'id': uuid4(), 'title': 'Published L1', 'version': 1}
        ])
        db_real.add_handler('SELECT id, COALESCE(published->>\'title\', title) AS title, version FROM learning.quizzes', [
            {'id': uuid4(), 'title': 'Published Q1', 'version': 1}
        ])
        reqs_real = _effective_requirements(db_real, course)
        self.assertEqual(len(reqs_real), 2)

    def test_check_and_issue_for_folder(self):
        fid = uuid4()
        # Mock DB returns empty list
        self.assertEqual(check_and_issue_for_folder(MockDB(), fid, 'alice'), [])

        # Real DB issues certificates for eligible classes
        cid = uuid4()
        db_real = MockDB(is_real=True)
        db_real.add_handler('SELECT * FROM learning.classes', [
            {'id': cid, 'folder_id': fid, 'title': 'Class 1', 'revision': 1, 'archived': False, 'deleted': False}
        ])
        db_real.add_handler('SELECT u.username, p.display_name FROM users', {
            'username': 'alice', 'display_name': 'Alice'
        })

        cert_item = {'id': str(uuid4()), 'recipient_name': 'Alice', 'course_title': 'Class 1'}
        with patch('buddy_learning.classrooms.ensure_folder_classes'), \
             patch('buddy_learning.classrooms.class_identity', return_value={'id': cid, 'folder_id': fid, 'title': 'Class 1', 'revision': 1}), \
             patch.object(course_completion, '_state', return_value=[{'certificate': cert_item}]):
            issued = check_and_issue_for_folder(db_real, fid, 'alice')
            self.assertEqual(len(issued), 1)
            self.assertEqual(issued[0]['course_title'], 'Class 1')

    def test_endpoints_claim_approve_revoke_and_download(self):
        cid = uuid4()
        cert_id = uuid4()
        user = {'username': 'alice', 'is_admin': True}

        # 1. Claim endpoint archived course -> 409
        with patch('buddy_learning.classrooms.authorize_class', return_value={'id': cid, 'archived': True}), \
             patch('app.job_queue._connect', return_value=MockDB()):
            with self.assertRaises(HTTPException) as ctx:
                course_completion.claim_completion_certificate(cid, ClaimCertificate(), user=user)
            self.assertEqual(ctx.exception.status_code, 409)

        # 2. Claim endpoint not eligible -> 409
        with patch('buddy_learning.classrooms.authorize_class', return_value={'id': cid, 'archived': False}), \
             patch('app.job_queue._connect', return_value=MockDB()), \
             patch.object(course_completion, '_state', return_value=[{'eligible': False}]):
            with self.assertRaises(HTTPException) as ctx:
                course_completion.claim_completion_certificate(cid, ClaimCertificate(), user=user)
            self.assertEqual(ctx.exception.status_code, 409)

        # 3. Approve endpoint validation errors
        with patch('buddy_learning.classrooms.authorize_class', return_value={'id': cid, 'archived': False, 'revision': 2}), \
             patch('app.job_queue._connect', return_value=MockDB()):
            appr = Approval(expected_revision=1, evidence_digest='a'*64, recipient_name='Bob')
            with self.assertRaises(HTTPException) as ctx:
                course_completion.approve_completion(cid, 'bob', appr, user=user)
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertIn('Course requirements changed', ctx.exception.detail)

        # 4. Revoke endpoint
        db_revoke = MockDB()
        cert_row = {'id': cert_id, 'class_id': cid, 'username': 'bob'}
        with patch('app.job_queue._connect', return_value=db_revoke), \
             patch.object(course_completion, 'authorized_certificate', return_value=cert_row):
            res_rev = course_completion.revoke_certificate(cert_id, Revocation(reason='Update'), user=user)
            self.assertTrue(res_rev['revoked'])

        # 5. Download certificate HTML & PDF
        async def run_downloads():
            with patch('app.job_queue._connect', return_value=MockDB()), \
                 patch.object(course_completion, 'authorized_certificate', return_value=cert_row), \
                 patch('buddy_learning.course_certificate.certificate_html', return_value='<html>Cert</html>'):
                # HTML download
                html_resp = await course_completion.download_certificate(cert_id, format='html', user=user)
                self.assertIn('text/html', html_resp.media_type)

                # PDF download
                with patch('app.research_pdf.render_pdf', AsyncMock(return_value=b'%PDF-fake')):
                    pdf_resp = await course_completion.download_certificate(cert_id, format='pdf', user=user)
                    self.assertEqual(pdf_resp.media_type, 'application/pdf')

        import asyncio
        asyncio.run(run_downloads())


class LearningServiceDeepTests(unittest.TestCase):
    """Deep unit tests for buddy_learning.service."""

    def test_set_members_validation_and_real_db(self):
        fid = uuid4()
        user = {'username': 'alice', 'roles': ['learning_admin']}

        # 1. Invalid Keycloak group path -> 422
        req_bad_group = service.Members(usernames=['bob'], groups=['InvalidGroupWithoutSlash'])
        with self.assertRaises(HTTPException) as ctx:
            service.set_members(fid, req_bad_group, user=user)
        self.assertEqual(ctx.exception.status_code, 422)

        # 2. Groups provided but no realm configured -> 503
        req_group = service.Members(usernames=['bob'], groups=['/Department/Dev'])
        with patch.object(service, 'realm', return_value=''):
            with self.assertRaises(HTTPException) as ctx:
                service.set_members(fid, req_group, user=user)
            self.assertEqual(ctx.exception.status_code, 503)

        # 3. Successful set_members on real DB updating teacher and class members
        cls_row = {'id': str(fid), 'teacher_username': 'teacher1'}
        db_real = MockDB(is_real=True)
        db_real.add_handler('SELECT username FROM users', [{'username': 'bob'}])
        db_real.add_handler('SELECT id,teacher_username FROM learning.classes', cls_row)
        req_ok = service.Members(usernames=['bob'], teacher_username='new_teacher')
        with patch('app.job_queue._connect', return_value=db_real), \
             patch('buddy_learning.store.folder', return_value={'id': str(fid)}), \
             patch('buddy_learning.classrooms.ensure_folder_classes'), \
             patch.object(service, '_is_real_db', return_value=True):
            service.set_members(fid, req_ok, user=user)
            queries = [q[0] for q in db_real.queries]
            self.assertTrue(any('UPDATE learning.classes' in q for q in queries))
            self.assertTrue(any('INSERT INTO learning.class_members' in q for q in queries))

    def test_update_quiz_chapter_edges(self):
        qid = uuid4()
        fid = uuid4()
        user = {'username': 'teacher1', 'is_admin': True}
        quiz_row = {'id': str(qid), 'folder_id': str(fid), 'draft': {}, 'published': {'title': 'Quiz'}}

        # 1. Lesson from another folder -> 422
        lid_wrong = uuid4()
        db_wrong = MockDB()
        db_wrong.add_handler('SELECT folder_id FROM learning.lessons', {'folder_id': str(uuid4())})
        with patch('app.job_queue._connect', return_value=db_wrong), \
             patch('buddy_learning.store.quiz', return_value=quiz_row):
            with self.assertRaises(HTTPException) as ctx:
                service.update_quiz_chapter(qid, service.QuizChapterInput(lesson_id=lid_wrong), user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 2. Success updating published quiz chapter
        lid_ok = uuid4()
        db_ok = MockDB()
        db_ok.add_handler('SELECT folder_id FROM learning.lessons', {'folder_id': str(fid)})
        with patch('app.job_queue._connect', return_value=db_ok), \
             patch('buddy_learning.store.quiz', return_value=quiz_row):
            res = service.update_quiz_chapter(qid, service.QuizChapterInput(lesson_id=lid_ok), user=user)
            self.assertEqual(res['lesson_id'], str(lid_ok))

    def test_update_class_note_edges(self):
        nid = uuid4()
        fid = uuid4()
        user = {'username': 'alice'}
        note_row = {
            'id': str(nid), 'folder_id': str(fid), 'username': 'alice',
            'title': 'Original', 'body': 'Note body', 'color': 'yellow',
            'tags': ['t1'], 'favorite': False, 'bob_note_id': 10
        }

        # 1. Empty body -> 422
        db = MockDB()
        db.add_handler('SELECT * FROM learning.class_notes', dict(note_row))
        with patch('app.job_queue._connect', return_value=db), \
             patch('buddy_learning.store.folder'):
            with self.assertRaises(HTTPException) as ctx:
                service.update_class_note(nid, service.ClassNotePatch(body='   '), user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # 2. Lesson from another class -> 422
        lid_diff = uuid4()
        db_lesson_diff = MockDB()
        db_lesson_diff.add_handler('SELECT * FROM learning.class_notes', dict(note_row))
        db_lesson_diff.add_handler('SELECT folder_id FROM learning.lessons', {'folder_id': str(uuid4())})
        with patch('app.job_queue._connect', return_value=db_lesson_diff), \
             patch('buddy_learning.store.folder'):
            with self.assertRaises(HTTPException) as ctx:
                service.update_class_note(nid, service.ClassNotePatch(lesson_id=lid_diff), user=user)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_chat_book_excerpt_truncation(self):
        fid = uuid4()
        bid = uuid4()
        user = {'username': 'alice', 'roles': ['teacher']}
        book = {'id': str(bid), 'folder_id': str(fid), 'title': 'Long Book', 'object_key': 'books/1/source.pdf'}

        async def run_chat():
            with patch('app.job_queue._connect', return_value=MockDB()), \
                 patch('buddy_learning.store.folder', return_value={'id': str(fid), 'name': 'Class Folder'}), \
                 patch('buddy_learning.store.can_create', return_value=True), \
                 patch('buddy_learning.store.book', return_value=book), \
                 patch('buddy_learning.service.parsed_book', return_value={'chapters': [{'id': 'c1', 'title': 'Ch1'}]}), \
                 patch('buddy_learning.service.chapter_plain', return_value='A' * 35000), \
                 patch('buddy_learning.assistant.respond', new_callable=AsyncMock) as mock_respond:
                mock_respond.return_value = SimpleNamespace(reply='Feedback', draft=None)
                chat_req = service.ChatRequest(message='Analyze chapter', book_id=bid)
                res = await service.chat(fid, chat_req, user=user)
                self.assertEqual(res['reply'], 'Feedback')
                context_used = mock_respond.call_args[1]['context']
                self.assertTrue(context_used['source']['truncated'])

        import asyncio
        asyncio.run(run_chat())


if __name__ == '__main__':
    unittest.main()
