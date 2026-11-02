import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from app import notification_inbox as inbox


class InboxTests(unittest.TestCase):
    def test_sources_and_read_markers_are_scoped_to_owner(self):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.execute.return_value.fetchall.return_value = [{'id':'task:own:1','kind':'task','status':'completed',
            'title':'Actual job','occurred_at':datetime.now(timezone.utc),'job_id':'own','session_id':'session','read_at':None}]
        with patch('app.toolbar_reminders.notifications',return_value=[]),patch.object(inbox,'ensure_schema'),patch.object(inbox,'missed_call_notifications',return_value=[]),patch.object(inbox,'community_notifications',return_value=[]),patch.object(inbox,'knowledge_notifications',return_value=[]),patch.object(inbox.job_queue,'_connect',return_value=connection):
            items=inbox.list_notifications('alice')
        self.assertEqual(items[0]['title'],'Actual job')
        self.assertIsNone(items[0]['read_at'])
        self.assertEqual(connection.execute.call_args.args[1],('alice','alice','alice','alice'))
        self.assertIn('j.username=%s',inbox.ITEMS_SQL)
        self.assertIn('f.username=%s',inbox.ITEMS_SQL)
        self.assertIn('a.worker_token=j.worker_token',inbox.ITEMS_SQL)

    def test_missed_calls_require_membership_and_unanswered_incoming_call(self):
        connection = MagicMock()
        connection.execute.return_value.fetchone.return_value = {'relation': 'people_chat.bob_voice_calls'}
        connection.execute.return_value.fetchall.return_value = []
        with patch('app.plugin_client.enabled', return_value=True):
            self.assertEqual(inbox.missed_call_notifications(connection, 'alice'), [])
        sql, params = connection.execute.call_args.args
        self.assertEqual(params, ('alice', 'alice', 'alice'))
        self.assertIn('m.username=%s', sql)
        self.assertIn('c.callee=%s', sql)
        self.assertIn('c.accepted_at IS NULL', sql)
        self.assertIn("c.status='ended'", sql)
        self.assertIn("c.status='ringing' AND c.created_at<now()-interval '45 seconds'", sql)
        self.assertIn('ORDER BY occurred_at DESC', sql)

    def test_cannot_mark_another_users_notice_read(self):
        with patch.object(inbox,'list_notifications',return_value=[]),patch.object(inbox.job_queue,'_connect') as connect:
            self.assertFalse(inbox.mark_read('alice','task:bobs-private-job'))
            connect.assert_not_called()

    def test_mark_read_persists_only_for_authenticated_owner(self):
        connection=MagicMock();connection.__enter__.return_value=connection
        with patch.object(inbox,'list_notifications',return_value=[{'id':'task:own:1'}]),patch.object(inbox.job_queue,'_connect',return_value=connection):
            self.assertTrue(inbox.mark_read('alice','task:own:1'))
        self.assertEqual(connection.execute.call_args.args[1],('alice','task:own:1'))
        self.assertIn('ON CONFLICT DO NOTHING',connection.execute.call_args.args[0])


if __name__=='__main__':
    unittest.main()
