"""Queue lifecycle behavior using an isolated database double."""
import json
import unittest
from unittest.mock import MagicMock, patch
from app import job_queue


class QueueLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.connection = MagicMock()
        self.connection.return_value.__enter__.return_value = self.db
        self.patches = [patch.object(job_queue, '_connect', self.connection), patch.object(job_queue, 'ensure_schema')]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_unique_prompts_exclude_other_conversations(self):
        self.db.execute.return_value.fetchall.return_value = [
            {'workspace_id': 'one', 'prompt': 'unique'}, {'workspace_id': 'one', 'prompt': 'shared'},
            {'workspace_id': 'two', 'prompt': 'shared'}, {'workspace_id': 'one', 'prompt': ''}]
        self.assertEqual(job_queue.session_unique_bob_prompts('alice', 'one'), {'unique'})

    def test_heartbeat_and_append_require_active_lease(self):
        self.db.execute.return_value.rowcount = 0
        self.assertFalse(job_queue.heartbeat('job', 'wrong'))
        self.db.execute.return_value.rowcount = 1
        self.assertTrue(job_queue.heartbeat('job', 'correct'))
        self.db.execute.return_value.fetchone.return_value = None
        self.assertFalse(job_queue.append_event('job', 'wrong', {'type': 'delta', 'text': 'secret'}))
        self.assertFalse(any('INSERT INTO bob_job_events' in c.args[0] for c in self.db.execute.call_args_list))

    def test_claim_records_running_job_and_returns_lease(self):
        row = {'id': 'job', 'username': 'alice', 'workspace_id': 'session', 'payload': {}, 'status': 'queued'}
        self.db.execute.return_value.fetchone.return_value = row
        with patch('app.delivery.persist_delivery') as delivery:
            result = job_queue.claim('worker')
        self.assertEqual(result['status'], 'running')
        self.assertEqual(result['worker_token'], 'worker')
        self.assertTrue(any('INSERT INTO bob_job_events' in call.args[0] for call in self.db.execute.call_args_list))
        delivery.assert_called_once()

    def test_missing_job_does_not_claim_or_cancel(self):
        self.db.execute.return_value.fetchone.return_value = None
        self.assertIsNone(job_queue.claim('worker'))
        self.assertIsNone(job_queue.request_cancel('missing', 'alice'))
        self.assertFalse(job_queue.cancellation_requested('missing'))

    def test_finish_persists_history_only_for_current_lease(self):
        row = {'username': 'alice', 'workspace_id': 'session', 'payload': {}}
        self.db.execute.return_value.fetchone.return_value = row
        with patch('app.postgres_storage.ensure_schema'), patch('app.delivery.persist_delivery') as delivery:
            self.assertTrue(job_queue.finish('job', 'token', {'type': 'done'}))
        sql = [call.args[0] for call in self.db.execute.call_args_list]
        self.assertTrue(any('INSERT INTO bob_conversation_history' in query for query in sql))
        self.assertTrue(any('UPDATE bob_jobs SET status' in query for query in sql))
        delivery.assert_called_once()
        self.db.reset_mock()
        self.db.execute.return_value.fetchone.return_value = None
        with patch('app.postgres_storage.ensure_schema'), patch('app.delivery.persist_delivery') as delivery:
            self.assertFalse(job_queue.finish('job', 'old-token', {'type': 'done'}))
        delivery.assert_not_called()
        self.assertEqual(self.db.execute.call_count, 1)

    def test_cancellation_distinguishes_queued_and_running(self):
        for status in ('queued', 'running', 'completed'):
            with self.subTest(status=status):
                self.db.reset_mock()
                row = {'status': status, 'payload': {}, 'workspace_id': 'session'}
                self.db.execute.return_value.fetchone.return_value = row
                with patch('app.delivery.persist_delivery') as delivery:
                    result = job_queue.request_cancel('job', 'alice')
                queries = [call.args[0] for call in self.db.execute.call_args_list]
                if status == 'queued':
                    self.assertEqual(result['status'], 'failed')
                    self.assertTrue(result['cancel_event']['cancelled'])
                    delivery.assert_called_once()
                else:
                    self.assertEqual(result['status'], status)
                    delivery.assert_not_called()
                self.assertEqual(any('UPDATE bob_jobs SET payload=payload' in q for q in queries), status != 'completed')

    def test_requeue_expired_obeys_retry_limit_and_cancellation(self):
        rows = [dict(id=str(i), username='alice', workspace_id='session', attempts=attempts,
                     max_attempts=2, payload=payload) for i, (attempts, payload) in enumerate(
                         [(1, {}), (2, {}), (1, {'cancel_requested': True})])]
        self.db.execute.return_value.fetchall.return_value = rows
        with patch('app.delivery.persist_delivery') as delivery:
            job_queue.requeue_expired()
        events = [json.loads(c.args[1][1]) for c in self.db.execute.call_args_list if 'INSERT INTO bob_job_events' in c.args[0]]
        self.assertEqual([event['type'] for event in events], ['status', 'error', 'error'])
        self.assertTrue(events[-1]['cancelled'])
        self.assertEqual(delivery.call_count, 3)

    def test_enqueue_validations(self):
        # Project deleted
        def exec_proj_del(sql, params=None):
            cur = MagicMock()
            if 'FROM projects' in sql:
                cur.fetchone.return_value = None
            else:
                cur.fetchone.return_value = None
                cur.fetchall.return_value = []
            return cur

        self.db.execute.side_effect = exec_proj_del
        with self.assertRaises(ValueError) as exc:
            job_queue.enqueue('alice', 'ws1', 'alice:project:p1', {})
        self.assertIn('Project has been deleted', str(exc.exception))

        # Conversation deleted
        def exec_conv_del(sql, params=None):
            cur = MagicMock()
            if 'FROM bob_deleted_conversations' in sql:
                cur.fetchone.return_value = (1,)
            else:
                cur.fetchone.return_value = None
                cur.fetchall.return_value = []
            return cur

        self.db.execute.side_effect = exec_conv_del
        with self.assertRaises(ValueError) as exc2:
            job_queue.enqueue('alice', 'ws1', 'alice:session:s1', {})
        self.assertIn('Conversation is being deleted', str(exc2.exception))

        # Message deleted
        def exec_msg_del(sql, params=None):
            cur = MagicMock()
            if 'FROM bob_conversations' in sql:
                cur.fetchone.return_value = {'record': {'history_revision': 1}}
            elif 'FROM bob_conversation_history' in sql:
                cur.fetchone.return_value = (1,)
            else:
                cur.fetchone.return_value = None
                cur.fetchall.return_value = []
            return cur

        self.db.execute.side_effect = exec_msg_del
        with self.assertRaises(ValueError) as exc3:
            job_queue.enqueue('alice', 'ws1', 'alice:session:s1', {'user_message_id': 'm1'})
        self.assertIn('This message was deleted', str(exc3.exception))

    def test_enqueue_success_and_auto_supersede(self):
        def exec_ok(sql, params=None):
            cur = MagicMock()
            if 'FROM bob_jobs WHERE workspace_key' in sql:
                cur.fetchall.return_value = [{'id': 'old-job', 'payload': {}, 'workspace_id': 'ws1'}]
            else:
                cur.fetchone.return_value = None
                cur.fetchall.return_value = []
            return cur

        self.db.execute.side_effect = exec_ok
        with patch('app.delivery.persist_delivery'):
            job_id = job_queue.enqueue('alice', 'ws1', 'alice:session:s1', {'prompt': 'hello'})
            self.assertIsNotNone(job_id)

    def test_auto_resolve_approval(self):
        # Job stopped
        self.db.execute.return_value.fetchone.return_value = None
        with self.assertRaises(RuntimeError) as exc:
            job_queue.auto_resolve_approval('job', 'tok', 'app_id')
        self.assertIn('Approval job was stopped', str(exc.exception))

        # Row already decided
        self.db.execute.side_effect = [
            MagicMock(fetchone=lambda: {'payload': {}}),
            MagicMock(fetchone=lambda: {'decision': 'approve'}),
        ]
        res = job_queue.auto_resolve_approval('job', 'tok', 'app_id')
        self.assertEqual(res, 'approve')

        # Review required -> returns None
        with patch('app.approval_policy.review_required', return_value=True):
            self.db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'payload': {}}),
                MagicMock(fetchone=lambda: {'decision': None, 'event': {'tool': {}}}),
            ]
            res2 = job_queue.auto_resolve_approval('job', 'tok', 'app_id')
            self.assertIsNone(res2)

        # Review not required -> updates and returns 'approve'
        with patch('app.approval_policy.review_required', return_value=False):
            self.db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'payload': {}}),
                MagicMock(fetchone=lambda: {'decision': None, 'event': {'tool': {}}}),
                MagicMock(), # update
            ]
            res3 = job_queue.auto_resolve_approval('job', 'tok', 'app_id')
            self.assertEqual(res3, 'approve')

    def test_interrupt_approval(self):
        # Job stopped
        self.db.execute.return_value.fetchone.return_value = None
        with self.assertRaises(RuntimeError) as exc:
            job_queue.interrupt_approval('job', 'tok', 'app_id')
        self.assertIn('Approval job was stopped', str(exc.exception))

        # Success reject
        self.db.execute.side_effect = [
            MagicMock(fetchone=lambda: (1,)), # job found
            MagicMock(), # update
        ]
        job_queue.interrupt_approval('job', 'tok', 'app_id')
        self.assertGreater(self.db.execute.call_count, 1)


if __name__ == '__main__':
    unittest.main()
