"""Enrollment notifications use profile addresses and isolate delivery failures."""
import unittest
from unittest.mock import MagicMock, patch

from buddy_learning import classrooms


class EnrollmentEmailTests(unittest.TestCase):
    def test_sends_individual_messages_and_continues_after_failure(self):
        db = MagicMock()
        db.execute.return_value.fetchall.return_value = [
            {'username': 'one', 'email': 'one@example.com'},
            {'username': 'two', 'email': 'two@example.com'},
        ]
        context = MagicMock()
        context.__enter__.return_value = db
        with patch('app.smtp_settings.load_config', return_value={'enabled': True}), \
             patch('app.smtp_settings.send_message', side_effect=[ValueError('failure'), 'accepted']) as send, \
             patch.object(classrooms.job_queue, '_connect', return_value=context), \
             self.assertLogs(classrooms.__name__, level='ERROR'):
            classrooms.notify_enrolled('Test course', ['one', 'two'])
        self.assertEqual(send.call_count, 2)
        self.assertEqual(send.call_args_list[1].args[1], 'two@example.com')

    def test_missing_address_is_skipped(self):
        db = MagicMock()
        db.execute.return_value.fetchall.return_value = []
        context = MagicMock()
        context.__enter__.return_value = db
        with patch('app.smtp_settings.load_config', return_value={'enabled': True}), \
             patch('app.smtp_settings.send_message') as send, \
             patch.object(classrooms.job_queue, '_connect', return_value=context), \
             self.assertLogs(classrooms.__name__, level='WARNING'):
            classrooms.notify_enrolled('Test course', ['learner'])
        send.assert_not_called()

    def test_disabled_smtp_does_not_send(self):
        with patch('app.smtp_settings.load_config', return_value={'enabled': False}), \
             patch('app.smtp_settings.send_message') as send, \
             self.assertLogs(classrooms.__name__, level='WARNING'):
            classrooms.notify_enrolled('Test course', ['one'])
        send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
