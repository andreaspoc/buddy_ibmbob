"""Synthetic completion and authorization tests. No real learners or certificates."""
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4
import unittest

from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.auth import current_user
from buddy_learning import service, lessons, course_completion as completion, classrooms
from buddy_learning.course_certificate import certificate_html

CLASS = str(uuid4())
CERTIFICATE = str(uuid4())


def assignment(identity, kind, **values):
    return {'id': identity, 'title': identity, 'revision': 2, 'resource_type': kind,
            'resource_id': str(uuid4()) if kind != 'none' else None, 'resource_version': 3,
            'required': True, 'minimum_score_percent': 70, **values}


class CompletionEvidenceTests(unittest.TestCase):
    def test_versioned_lessons_quiz_threshold_and_reviewed_homework(self):
        items = [assignment('lesson', 'lesson'), assignment('quiz', 'quiz'), assignment('work', 'none'), assignment('optional', 'none', required=False)]
        lesson = {'lesson': {'completed': True, 'updated_at': 'date'}}
        quiz = {'quiz': {'id': 'attempt', 'score': 7, 'max_score': 10, 'pending_manual': False, 'grades': {'q': {'score': 7}}}}
        work = {'work': {'id': 'submission', 'assignment_revision': 2, 'reviewed_at': 'date', 'revision': 4}}
        evidence = completion.completion_evidence(items, lesson, quiz, work)
        self.assertEqual(len(evidence), 3)
        self.assertTrue(all(row['completed'] for row in evidence))
        self.assertEqual(evidence[1]['minimum_score_percent'], 70)
        self.assertEqual(evidence[1]['resource_version'], 3)
        self.assertEqual(evidence[2]['submission_revision'], 4)

    def test_pending_scores_low_scores_and_old_homework_block_completion(self):
        item = assignment('quiz', 'quiz')
        for score, pending in ((10, True), (6, False)):
            evidence = completion.completion_evidence([item], {}, {'quiz': {'id': 'a', 'score': score, 'max_score': 10, 'pending_manual': pending, 'grades': {}}}, {})
            self.assertFalse(evidence[0]['completed'])
        evidence = completion.completion_evidence([assignment('work', 'book')], {}, {}, {'work': {'id': 'old', 'assignment_revision': 1, 'reviewed_at': 'date', 'revision': 1}})
        self.assertFalse(evidence[0]['completed'])
        self.assertFalse(completion.completion_evidence([assignment('lesson', 'lesson')], {}, {}, {})[0]['completed'])

    def test_certificate_is_escaped_and_uses_persisted_names_and_revocation(self):
        row = {'id': CERTIFICATE, 'recipient_name': '<script>name</script>', 'course_title': 'Human course & practice',
               'instructor_name': 'Teacher', 'issued_at': datetime(2026, 1, 1, tzinfo=timezone.utc), 'version': 1}
        rendered = certificate_html(row)
        self.assertIn('&lt;script&gt;name&lt;/script&gt;', rendered)
        self.assertNotIn('<script>', rendered)
        self.assertIn('Human course &amp; practice', rendered)
        self.assertIn('Buddy', rendered)
        self.assertIn(CERTIFICATE, rendered)
        row.update(revoked_at='date', revocation_reason='Name <correction>')
        self.assertIn('REVOKED', certificate_html(row))
        self.assertIn('Name &lt;correction&gt;', certificate_html(row))


class CompletionHttpTests(unittest.TestCase):
    def setUp(self):
        self.user = {'username': 'teacher', 'display_name': 'Human Teacher'}
        self.course = {'id': CLASS, 'folder_id': str(uuid4()), 'title': 'Human course', 'revision': 5,
                       'archived': False, 'can_manage': True, 'created_by': 'teacher'}
        self.evidence = {'username': 'learner', 'display_name': 'Learner Name', 'eligible': True,
                         'requirements': [{'completed': True}], 'evidence_digest': 'a' * 64, 'certificate': None}
        self.writes = []
        self.db = Mock()
        self.db.execute.side_effect = self.execute
        self.latest = None
        @contextmanager
        def connect():
            yield self.db
        self.enterContext(patch.object(completion.job_queue, '_connect', connect))
        self.target_access = self.enterContext(patch.object(completion.store, 'folder', return_value={'id': self.course['folder_id']}))
        self.authorize = self.enterContext(patch.object(classrooms, 'authorize_class', return_value=self.course))
        self.enterContext(patch.object(completion, '_state', side_effect=lambda *args, **kwargs: [self.evidence]))
        self.enterContext(patch.object(completion, '_roster', return_value=[{'username': 'learner'}]))
        self.enterContext(patch('app.auth.current_user', new=AsyncMock(side_effect=lambda request: self.user)))
        app = service.create_app()
        app.dependency_overrides[current_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def execute(self, sql, params=None):
        cursor = Mock()
        if sql.startswith('SELECT m.username,u.is_admin FROM learning.class_members'):
            cursor.fetchone.return_value = {'username': 'learner', 'is_admin': False}
        elif sql.startswith('SELECT * FROM learning.course_certificates WHERE class_id'):
            cursor.fetchone.return_value = self.latest
        elif sql.startswith('INSERT INTO learning.course_certificates'):
            self.writes.append((sql, params))
            cursor.fetchone.return_value = {'id': params[0], 'class_id': CLASS, 'version': params[3], 'recipient_name': params[4],
                                           'course_title': params[5], 'instructor_name': params[6], 'issued_at': 'now', 'revoked_at': None}
        else:
            raise AssertionError('Unexpected query in synthetic test: ' + sql)
        return cursor

    def approve(self, **override):
        return self.client.post(f'/api/learning/classes/{CLASS}/completions/learner/approve', json={
            'expected_revision': 5, 'evidence_digest': 'a' * 64, 'recipient_name': 'Learner Name', **override})

    def test_approval_is_explicit_teacher_action_with_names_and_evidence_snapshot(self):
        response = self.approve()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['certificate']['recipient_name'], 'Learner Name')
        self.assertEqual(self.writes[0][1][5:8], ('Human course', 'Human Teacher', 'teacher'))
        self.assertTrue(self.authorize.call_args.kwargs['manage'])
        self.assertTrue(self.authorize.call_args.kwargs['lock'])

    def test_stale_progress_or_requirements_and_incomplete_work_cannot_issue(self):
        self.assertEqual(self.approve(expected_revision=4).status_code, 409)
        self.assertEqual(self.approve(evidence_digest='b' * 64).status_code, 409)
        self.evidence['eligible'] = False
        self.assertEqual(self.approve().status_code, 409)
        self.assertEqual(self.writes, [])

    def test_learner_cannot_approve_and_cross_origin_request_is_rejected(self):
        self.authorize.side_effect = HTTPException(403, 'Teacher approval required')
        self.assertEqual(self.approve().status_code, 403)
        self.authorize.side_effect = None
        response = self.client.post(f'/api/learning/classes/{CLASS}/completions/learner/approve', headers={'Origin': 'https://other.invalid'}, json={
            'expected_revision': 5, 'evidence_digest': 'a' * 64, 'recipient_name': 'Learner Name'})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.writes, [])

    def test_lost_learner_folder_access_blocks_certificate_issuance(self):
        self.target_access.side_effect = HTTPException(404, 'Folder not found')
        response = self.approve()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.writes, [])

    def test_existing_active_certificate_is_idempotent_and_not_rewritten(self):
        self.latest = {'id': CERTIFICATE, 'class_id': CLASS, 'version': 1, 'recipient_name': 'Original Name',
                       'course_title': 'Original Course', 'instructor_name': 'Teacher', 'issued_at': 'date',
                       'evidence_digest': 'a' * 64, 'revoked_at': None}
        response = self.approve(recipient_name='Changed Name')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['existing'])
        self.assertEqual(response.json()['certificate']['recipient_name'], 'Original Name')
        self.assertEqual(self.writes, [])

    def test_download_renders_only_authorized_persisted_snapshot(self):
        row = {'id': CERTIFICATE, 'class_id': CLASS, 'username': 'learner', 'recipient_name': 'Saved <Name>',
               'course_title': 'Saved course', 'instructor_name': 'Teacher', 'issued_at': 'date', 'version': 1}
        with patch.object(completion, 'authorized_certificate', return_value=row) as authorize, \
             patch('app.research_pdf.render_pdf', new=AsyncMock(return_value=b'%PDF-synthetic-preview')) as renderer:
            response = self.client.get(f'/api/learning/certificates/{CERTIFICATE}/download?format=pdf')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['content-type'], 'application/pdf')
            self.assertIn('no-store', response.headers['cache-control'])
            self.assertIn('Saved &lt;Name&gt;', renderer.await_args.args[0])
            self.assertEqual(authorize.call_args.args[2]['username'], 'teacher')
            html = self.client.get(f'/api/learning/certificates/{CERTIFICATE}/download?format=html')
            self.assertIn('Saved &lt;Name&gt;', html.text)
            self.assertIn('sandbox', html.headers['content-security-policy'])

    def test_revocation_requires_course_management_and_keeps_record(self):
        row = {'id': CERTIFICATE, 'class_id': CLASS, 'username': 'learner'}
        self.db.execute.side_effect = None
        with patch.object(completion, 'authorized_certificate', return_value=row) as authorize:
            response = self.client.post(f'/api/learning/certificates/{CERTIFICATE}/revoke', json={'reason': 'Recipient name correction'})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(authorize.call_args.kwargs['manage'])
            self.assertTrue(authorize.call_args.kwargs['lock'])
            sql, params = self.db.execute.call_args.args
            self.assertIn('UPDATE learning.course_certificates SET revoked_at=', sql)
            self.assertIn('Recipient name correction', params)
            self.assertNotIn('DELETE', sql)
            self.assertEqual(self.client.post(f'/api/learning/certificates/{CERTIFICATE}/revoke', json={'reason': ' '}).status_code, 422)

    def test_certificate_download_is_owner_or_course_manager_only(self):
        row = {'id': CERTIFICATE, 'class_id': CLASS, 'username': 'another-learner'}
        self.db.execute.side_effect = lambda *args, **kwargs: Mock(fetchone=Mock(return_value=row))
        self.course['can_manage'] = False
        with self.assertRaises(HTTPException) as caught:
            completion.authorized_certificate(self.db, CERTIFICATE, {'username': 'learner'})
        self.assertEqual(caught.exception.status_code, 404)
        self.authorize.assert_called_once()
        self.assertEqual(completion.authorized_certificate(self.db, CERTIFICATE, {'username': 'another-learner'}), row)

    def test_certificate_email_delivery_pending_smtp_and_sent(self):
        import types
        cert = {'id': CERTIFICATE, 'class_id': CLASS, 'username': 'learner', 'recipient_name': 'Learner Example',
            'course_title': 'Artificial Intelligence', 'instructor_name': 'Teacher Example', 'version': 1,
            'issued_at': datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc), 'revoked_at': None}
        real_like_db = Mock()
        real_like_db.info = object()
        real_like_db.execute.side_effect = lambda sql, params=(): (
            Mock(fetchone=Mock(return_value={'email': 'learner@example.com', 'username': 'learner'}))
            if 'FROM bob_user_profiles' in sql else Mock(fetchone=Mock(return_value=None), fetchall=Mock(return_value=[]))
        )
        fake_smtp = types.SimpleNamespace(load_config=Mock(return_value={'enabled': False}), send_message=Mock())
        with patch.dict('sys.modules', {'app.smtp_settings': fake_smtp}):
            res_pending = completion.deliver_certificate_email(real_like_db, cert)
            self.assertEqual(res_pending['email_status'], 'pending_smtp')
            self.assertEqual(res_pending['email_recipient'], 'learner@example.com')

            fake_smtp.load_config.return_value = {'enabled': True, 'host': 'smtp.buddy.local', 'from_address': 'learning@example.com'}
            with patch.object(completion.from_thread, 'run', return_value=b'%PDF-test'):
                res_sent = completion.deliver_certificate_email(real_like_db, cert)
            self.assertEqual(res_sent['email_status'], 'sent')
            self.assertEqual(res_sent['email_recipient'], 'learner@example.com')
            fake_smtp.send_message.assert_called_once()
            _, _, send_subject, _ = fake_smtp.send_message.call_args.args[:4]
            self.assertIn('Artificial Intelligence', send_subject)
            attachments = fake_smtp.send_message.call_args.kwargs.get('attachments') or []
            self.assertEqual(len(attachments), 1)
            self.assertTrue(attachments[0][0].endswith('.pdf'))
            self.assertEqual(attachments[0][1], b'%PDF-test')
            self.assertEqual(attachments[0][2], 'application/pdf')

    def test_pdf_failure_records_error_without_sending_email(self):
        import types
        cert = {'id': CERTIFICATE, 'class_id': CLASS, 'username': 'learner', 'recipient_name': 'Learner',
                'course_title': 'Example', 'instructor_name': 'Teacher', 'version': 1,
                'issued_at': datetime(2026, 1, 1, tzinfo=timezone.utc)}
        db = Mock()
        db.info = object()
        db.execute.side_effect = lambda sql, params=(): Mock(fetchone=Mock(return_value=(
            {'email': 'learner@example.test'} if 'FROM bob_user_profiles' in sql else None)))
        smtp = types.SimpleNamespace(load_config=Mock(return_value={'enabled': True, 'host': 'mail.example.test',
            'from_address': 'teacher@example.test'}), send_message=Mock())
        with patch.dict('sys.modules', {'app.smtp_settings': smtp}), \
             patch.object(completion.from_thread, 'run', side_effect=RuntimeError('PDF renderer unavailable')):
            result = completion.deliver_certificate_email(db, cert)
        self.assertEqual(result['email_status'], 'failed')
        self.assertIn('PDF renderer unavailable', result['email_error'])
        smtp.send_message.assert_not_called()

    def test_ensure_folder_classes_migrates_existing_folders(self):
        from buddy_learning import classrooms
        db = Mock()
        classrooms.ensure_folder_classes(db)
        executed_sql = '\n'.join(call.args[0] for call in db.execute.call_args_list)
        self.assertIn('INSERT INTO learning.classes', executed_sql)
        self.assertIn('FROM learning.folders f', executed_sql)
        self.assertIn('JOIN learning.members m', executed_sql)
