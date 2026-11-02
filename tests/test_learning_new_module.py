"""Synthetic tests: adding modules notifies learners and re-dates certificates only for new completions."""
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4
import unittest

from buddy_learning import classrooms, course_completion as completion, lessons, service

FOLDER = str(uuid4())
CLASS = str(uuid4())
TEACHER = {'username': 'teacher', 'is_admin': False}


def requirement(resource_id='lesson-1', version=1, title='Module', revision=1, **values):
    return {'assignment_id': f'lesson:{resource_id}', 'title': title, 'assignment_revision': revision,
            'resource_type': 'lesson', 'resource_id': resource_id, 'resource_version': version,
            'completed': True, **values}


@contextmanager
def connection(db):
    yield db


class CertificateReissueRuleTests(unittest.TestCase):
    def test_first_completion_issues_and_revoked_certificate_is_not_replaced(self):
        self.assertTrue(completion._needs_new_certificate(None, [requirement()]))
        revoked = {'revoked_at': 'date', 'evidence': []}
        self.assertFalse(completion._needs_new_certificate(revoked, [requirement()]))

    def test_cosmetic_and_removal_changes_do_not_reissue(self):
        cert = {'revoked_at': None, 'evidence': [requirement(), requirement('lesson-2')]}
        renamed = [requirement(title='Renamed', revision=9, updated_at='later', assignment_id='linked-assignment')]
        self.assertFalse(completion._needs_new_certificate(cert, renamed))

    def test_new_module_or_new_module_version_reissues(self):
        cert = {'revoked_at': None, 'evidence': [requirement()]}
        self.assertTrue(completion._needs_new_certificate(cert, [requirement(), requirement('lesson-2')]))
        self.assertTrue(completion._needs_new_certificate(cert, [requirement(version=2)]))

    def test_homework_without_resource_uses_assignment_identity(self):
        homework = {'assignment_id': 'work-1', 'resource_type': 'none', 'resource_id': None, 'resource_version': None}
        cert = {'revoked_at': None, 'evidence': [homework]}
        self.assertFalse(completion._needs_new_certificate(cert, [{**homework, 'title': 'Edited'}]))
        self.assertTrue(completion._needs_new_certificate(cert, [homework, {**homework, 'assignment_id': 'work-2'}]))


class CertificateIssueStateTests(unittest.TestCase):
    """Runs _state's real issuing branch against a scripted database."""

    def run_state(self, assignments, progress, cert):
        inserts = []

        def execute(sql, params=None):
            cursor = MagicMock()
            cursor.fetchall.return_value = []
            if 'FROM learning.course_certificates' in sql:
                cursor.fetchall.return_value = [cert] if cert else []
            elif 'FROM learning.lesson_progress' in sql and 'JOIN learning.class_assignments' in sql:
                cursor.fetchall.return_value = progress
            elif sql.startswith('INSERT INTO learning.course_certificates'):
                inserts.append(params)
                cursor.fetchone.return_value = {'id': params[0], 'username': params[2], 'version': params[3],
                                                'recipient_name': params[4], 'revoked_at': None}
            return cursor

        db = SimpleNamespace(info=object(), execute=execute)
        course = {'id': CLASS, 'folder_id': FOLDER, 'title': 'Course', 'revision': 7, 'archived': False,
                  'teacher_display_name': 'Teacher', 'teacher_username': 'teacher'}
        with patch.object(completion, '_effective_requirements', return_value=assignments), \
                patch.object(completion, 'deliver_certificate_email', side_effect=lambda _db, row: row) as deliver:
            state = completion._state(db, course, [{'username': 'learner', 'display_name': 'Display Name'}], auto_issue=True)[0]
        return state, inserts, deliver

    @staticmethod
    def assignment(identity):
        return {'id': identity, 'title': identity, 'revision': 1, 'resource_type': 'lesson', 'resource_id': identity,
                'resource_version': 1, 'required': True}

    @staticmethod
    def done(identity):
        return {'assignment_id': identity, 'username': 'learner', 'completed': True, 'updated_at': 'date'}

    @staticmethod
    def certificate(evidence):
        return {'id': str(uuid4()), 'username': 'learner', 'version': 1, 'recipient_name': 'Name On Certificate',
                'revoked_at': None, 'evidence': evidence, 'evidence_digest': 'old'}

    def old_evidence(self):
        return [{'assignment_id': 'one', 'resource_type': 'lesson', 'resource_id': 'one', 'resource_version': 1}]

    def test_unfinished_new_module_keeps_certificate_and_sends_nothing(self):
        cert = self.certificate(self.old_evidence())
        state, inserts, deliver = self.run_state([self.assignment('one'), self.assignment('two')], [self.done('one')], cert)
        self.assertFalse(state['eligible'])
        self.assertEqual(state['certificate']['version'], 1)
        self.assertEqual(inserts, [])
        deliver.assert_not_called()

    def test_finishing_new_module_issues_and_emails_new_version_with_same_name(self):
        cert = self.certificate(self.old_evidence())
        state, inserts, deliver = self.run_state([self.assignment('one'), self.assignment('two')],
                                                 [self.done('one'), self.done('two')], cert)
        self.assertEqual(state['certificate']['version'], 2)
        self.assertEqual(state['certificate']['recipient_name'], 'Name On Certificate')
        self.assertEqual(len(inserts), 1)
        deliver.assert_called_once()

    def test_changed_digest_without_new_completion_does_not_resend(self):
        cert = self.certificate(self.old_evidence())
        state, inserts, deliver = self.run_state([self.assignment('one')], [self.done('one')], cert)
        self.assertNotEqual(state['evidence_digest'], cert['evidence_digest'])
        self.assertEqual(inserts, [])
        deliver.assert_not_called()

    def test_first_completion_uses_learner_name(self):
        state, inserts, _ = self.run_state([self.assignment('one')], [self.done('one')], None)
        self.assertEqual(state['certificate']['version'], 1)
        self.assertEqual(inserts[0][4], 'Display Name')


class NewModuleEmailTests(unittest.TestCase):
    def db_with(self, rows):
        db = MagicMock()
        db.execute.return_value.fetchall.return_value = rows
        return db

    def test_emails_each_learner_once_and_skips_publisher(self):
        rows = [{'title': 'Class A', 'username': 'one'}, {'title': 'Class A', 'username': 'teacher'},
                {'title': 'Class B', 'username': 'one'}, {'title': 'Class B', 'username': 'two'}]
        with patch.object(classrooms.job_queue, '_connect', return_value=connection(self.db_with(rows))), \
                patch.object(classrooms, 'ensure_folder_classes'), \
                patch.object(classrooms, '_email_members') as email:
            classrooms.notify_new_module('Phishing', folder_id=FOLDER, exclude='teacher')
        kind, messages = email.call_args.args
        self.assertEqual(kind, 'New module')
        self.assertEqual(sorted(messages), ['one', 'two'])
        self.assertIn('Class A', messages['one'][0])
        self.assertIn('Phishing', messages['one'][1])
        self.assertIn('updated certificate', messages['one'][1])

    def test_lookup_failure_never_breaks_publishing(self):
        with patch.object(classrooms.job_queue, '_connect', side_effect=OSError('database down')), \
                patch.object(classrooms, '_email_members') as email, \
                self.assertLogs(classrooms.__name__, level='ERROR'):
            classrooms.notify_new_module('Phishing', class_id=CLASS)
        email.assert_not_called()

    def test_titles_cannot_inject_email_headers(self):
        subject, _ = classrooms.new_module_message('Course\r\nBcc: x@example.com', 'Module')
        self.assertNotIn('\n', subject)
        self.assertNotIn('\r', subject)

    def test_disabled_smtp_sends_nothing(self):
        with patch('app.smtp_settings.load_config', return_value={'enabled': False}), \
                patch('app.smtp_settings.send_message') as send, \
                self.assertLogs(classrooms.__name__, level='WARNING'):
            classrooms._email_members('New module', {'one': ('subject', 'body')})
        send.assert_not_called()

    def test_empty_recipients_do_not_load_settings(self):
        with patch('app.smtp_settings.load_config') as load:
            classrooms._email_members('New module', {})
        load.assert_not_called()

    def test_settings_failure_is_logged(self):
        with patch('app.smtp_settings.load_config', side_effect=OSError('settings')), \
                self.assertLogs(classrooms.__name__, level='ERROR'):
            classrooms._email_members('New module', {'one': ('subject', 'body')})


class PublishNotificationTests(unittest.TestCase):
    def publish_lesson(self, published):
        row = {'folder_id': FOLDER, 'draft': {}, 'published': published}
        spec = SimpleNamespace(title='Lesson title')
        with patch.object(lessons.job_queue, '_connect', return_value=connection(MagicMock())), \
                patch.object(lessons, 'lookup', return_value=(row, True)), \
                patch.object(lessons, 'check_draft'), patch.object(lessons, 'check_assets'), \
                patch.object(lessons.LessonInput, 'model_validate', return_value=spec), \
                patch.object(classrooms, 'notify_new_module') as notify:
            self.assertEqual(lessons.publish(uuid4(), SimpleNamespace(expected_digest=None), user=TEACHER), {'published': True})
        return notify

    def test_first_lesson_publish_notifies(self):
        self.publish_lesson(None).assert_called_once_with('Lesson title', folder_id=FOLDER, exclude='teacher')

    def test_republishing_a_lesson_does_not_notify(self):
        self.publish_lesson({'title': 'Old'}).assert_not_called()

    def publish_quiz(self, **row):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = {'version': 1}
        record = {'status': 'draft', 'draft': {}, 'version': 0, **row}
        with patch.object(service.job_queue, '_connect', return_value=connection(db)), \
                patch.object(service.store, 'quiz', return_value=record), patch.object(service.store, 'creator'), \
                patch.object(service.QuizInput, 'model_validate', return_value=SimpleNamespace(title='Quiz title')), \
                patch.object(classrooms, 'notify_new_module') as notify:
            self.assertTrue(service.publish(uuid4(), user=TEACHER)['published'])
        return notify

    def test_first_quiz_publish_notifies(self):
        self.publish_quiz(folder_id=FOLDER, published=None).assert_called_once_with('Quiz title', folder_id=FOLDER, exclude='teacher')

    def test_reopened_or_folderless_quiz_does_not_notify(self):
        self.publish_quiz(folder_id=FOLDER, published={'title': 'Old'}).assert_not_called()
        self.publish_quiz(folder_id=None, published=None).assert_not_called()


class AssignmentNotificationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(classrooms.job_queue, '_connect', side_effect=lambda: connection(MagicMock())))
        self.enterContext(patch.object(classrooms, 'authorize_class', return_value={'id': CLASS, 'folder_id': FOLDER}))
        self.enterContext(patch.object(classrooms, 'ensure_open'))
        self.enterContext(patch.object(classrooms, 'save_assignment', return_value={'id': 'saved'}))
        self.notify = self.enterContext(patch.object(classrooms, 'notify_new_module'))

    def create(self, required, resource_type='none'):
        req = SimpleNamespace(required=required, resource_type=resource_type, title='Homework')
        self.assertEqual(classrooms.create_assignment(CLASS, req, user=TEACHER), {'id': 'saved'})

    def test_required_homework_notifies_class(self):
        self.create(True)
        self.notify.assert_called_once_with('Homework', class_id=CLASS, exclude='teacher')

    def test_optional_or_already_announced_material_does_not_notify(self):
        self.create(False)
        self.create(True, 'lesson')
        self.create(True, 'quiz')
        self.notify.assert_not_called()

    def edit(self, was_required, required):
        req = SimpleNamespace(required=required, title='Homework')
        with patch.object(classrooms, 'assignment', return_value={'required': was_required}):
            self.assertEqual(classrooms.edit_assignment(CLASS, uuid4(), req, user=TEACHER), {'id': 'saved'})

    def test_making_an_assignment_required_notifies_once(self):
        self.edit(False, True)
        self.notify.assert_called_once_with('Homework', class_id=CLASS, exclude='teacher')

    def test_other_edits_do_not_notify(self):
        self.edit(True, True)
        self.edit(False, False)
        self.edit(True, False)
        self.notify.assert_not_called()


class GradingIssuesCertificateTests(unittest.TestCase):
    def test_homework_review_checks_the_learner_not_the_teacher(self):
        db = MagicMock()
        db.execute.return_value.fetchone.side_effect = [{'username': 'learner', 'revision': 1}, {'id': 'updated'}]
        req = SimpleNamespace(expected_revision=1, feedback='Good', mark=1, max_mark=1)
        with patch.object(classrooms.job_queue, '_connect', return_value=connection(db)), \
                patch.object(classrooms, 'authorize_class', return_value={'folder_id': FOLDER}), \
                patch.object(classrooms, 'ensure_open'), patch.object(classrooms, 'assignment'), \
                patch.object(classrooms, 'revision'), \
                patch.object(completion, 'check_and_issue_for_folder') as issue:
            self.assertEqual(classrooms.feedback(CLASS, uuid4(), uuid4(), req, user=TEACHER), {'id': 'updated'})
        issue.assert_called_once_with(db, FOLDER, 'learner')

    def grade(self, score, folder_id=FOLDER):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = {
            'quiz_id': uuid4(), 'username': 'learner', 'grades': {},
            'questions': [{'id': 'q1', 'type': 'text', 'points': 5}]}
        mark = MagicMock(score=score)
        mark.model_dump.return_value = {'score': score}
        with patch.object(service.job_queue, '_connect', return_value=connection(db)), \
                patch.object(service, 'review_quiz', return_value={'folder_id': folder_id}), \
                patch.object(completion, 'check_and_issue_for_folder') as issue:
            self.assertEqual(service.manual_grade(uuid4(), SimpleNamespace(grades={'q1': mark}), user=TEACHER), {'saved': True})
        return db, issue

    def test_final_manual_grade_checks_the_learner(self):
        db, issue = self.grade(5)
        issue.assert_called_once_with(db, FOLDER, 'learner')

    def test_folderless_quiz_is_not_checked(self):
        _, issue = self.grade(5, folder_id=None)
        issue.assert_not_called()


if __name__ == '__main__':
    unittest.main()
