"""Interactive state ownership and actions; no database or mail server required."""
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError
from app import interactive_widgets as widgets


@contextmanager
def connection(db):
    yield db


class InteractiveWidgetTests(TestCase):
    user = {'username': 'alice'}
    key = 'a' * 64
    source = 'b' * 64

    def action(self, **changes):
        return widgets.NoteAction(**({'session_id': 'c' * 32, 'action': 'save_note',
                                      'title': 'Reviewed title', 'body': 'Reviewed body'} | changes))

    def test_state_and_actions_require_owned_session_before_side_effects(self):
        with patch.object(widgets.sessions, 'get_session', side_effect=FileNotFoundError), \
                patch.object(widgets.job_queue, '_connect') as db, \
                patch.object(widgets.notes, 'create_note') as save:
            for operation in (
                lambda: widgets.get_state('c'*32, self.key, self.source, self.user),
                lambda: widgets.put_state('c'*32, self.key, widgets.StateUpdate(source_hash=self.source, state={}), self.user),
                lambda: widgets.execute_action(self.action(), self.user),
            ):
                with self.assertRaises(HTTPException) as error:
                    operation()
                self.assertEqual(error.exception.status_code, 404)
            db.assert_not_called()
            save.assert_not_called()

    def test_state_reads_include_owner_and_source_hash(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = {'state': {'done': [1]}}
        with patch.object(widgets.sessions, 'get_session'), patch.object(widgets.job_queue, '_connect', lambda: connection(db)):
            result = widgets.get_state('c'*32, self.key, self.source, self.user)
        self.assertEqual(result, {'state': {'done': [1]}})
        self.assertEqual(db.execute.call_args.args[1], ('alice', 'c'*32, self.key, self.source))

    def test_state_upsert_binds_owner_and_bounded_json(self):
        db = MagicMock()
        body = widgets.StateUpdate(source_hash=self.source, state={'done': [2, 1, 2], 'values': {'total': '12'}})
        with patch.object(widgets.sessions, 'get_session'), patch.object(widgets.job_queue, '_connect', lambda: connection(db)):
            result = widgets.put_state('c'*32, self.key, body, self.user)
        args = db.execute.call_args.args[1]
        self.assertEqual(args[:4], ('alice', 'c'*32, self.key, self.source))
        self.assertEqual(args[4].obj, result['state'])
        self.assertEqual(result['state']['done'], [1, 2])
        for invalid in ({'done': [-1]}, {'values': {'total': 'a'*65}}, {'arbitrary': 'bad'}):
            with self.assertRaises(ValidationError):
                widgets.WidgetState(**invalid)

    def test_save_uses_reviewed_content_and_authenticated_owner(self):
        with patch.object(widgets.sessions, 'get_session'), patch.object(widgets.notes, 'create_note', return_value={'id': 7}) as save:
            result = widgets.execute_action(self.action(), self.user)
        self.assertEqual(result['note']['id'], 7)
        self.assertEqual(save.call_args.args[0].body, 'Reviewed body')
        self.assertEqual(save.call_args.args[1], self.user)

    def test_email_uses_markdown_attachment_once(self):
        with patch.object(widgets.sessions, 'get_session'), \
                patch.object(widgets.smtp_settings, 'load_config', return_value={'enabled': True}), \
                patch.object(widgets.smtp_settings, 'send_message', return_value='SMTP server accepted the email for delivery.') as send:
            result = widgets.execute_action(self.action(action='email_note', recipient='me@example.com', title='../A / note'), self.user)
        send.assert_called_once()
        name, content = send.call_args.kwargs['markdown_attachment']
        self.assertNotIn('/', name)
        self.assertTrue(name.endswith('.md'))
        self.assertEqual(content, '# ../A / note\n\nReviewed body')
        self.assertIn('accepted', result['message'])

    def test_disabled_smtp_never_sends_and_errors_do_not_leak(self):
        with patch.object(widgets.sessions, 'get_session'), \
                patch.object(widgets.smtp_settings, 'load_config', return_value={'enabled': False}), \
                patch.object(widgets.smtp_settings, 'send_message') as send:
            with self.assertRaises(HTTPException):
                widgets.execute_action(self.action(action='email_note', recipient='me@example.com'), self.user)
            send.assert_not_called()
        with patch.object(widgets.sessions, 'get_session'), \
                patch.object(widgets.smtp_settings, 'load_config', return_value={'enabled': True}), \
                patch.object(widgets.smtp_settings, 'send_message', side_effect=ValueError('secret-password')) as send:
            with self.assertRaises(HTTPException) as error:
                widgets.execute_action(self.action(action='email_note', recipient='me@example.com'), self.user)
            self.assertNotIn('secret', error.exception.detail)
            send.assert_called_once()

    def test_missing_or_changed_source_has_no_saved_state(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = None
        with patch.object(widgets.sessions, 'get_session'), patch.object(widgets.job_queue, '_connect', lambda: connection(db)):
            self.assertEqual(widgets.get_state('c'*32, self.key, self.source, self.user), {'state': None})

    def test_actions_validate_before_sending(self):
        for values in ({'action': 'delete_all'}, {'action': 'email_note'},
                       {'action': 'email_note', 'recipient': 'a@example.com\r\nBcc: b@example.com'},
                       {'title': 'Injected\r\nsubject'}, {'body': ' '}):
            with self.assertRaises(ValidationError):
                self.action(**values)
