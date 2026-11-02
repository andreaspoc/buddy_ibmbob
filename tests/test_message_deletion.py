"""Deleting one chat message must remove its text while preserving its sibling."""
import copy
import unittest
from unittest.mock import Mock, MagicMock, patch

from app.conversation_context import add_conversation_context
from app.message_deletion import message_ids, plan_deletion
from fastapi import HTTPException
from app.blob_storage import _erase_object


class DeletedConversationContextTests(unittest.TestCase):
    def context(self, events):
        return add_conversation_context('Current unrelated question', events + [
            {'type': 'request', 'prompt': 'Current unrelated question'},
        ], [], workspace='/workspace/chat', include_history=True)

    def test_deleted_question_keeps_answer_as_followup_context(self):
        context = self.context([
            {'type': 'request', 'user_deleted': True, 'prompt': 'PRIVATE QUESTION'},
            {'type': 'delta', 'text': 'Retained answer for followup'},
            {'type': 'done'},
        ])
        self.assertNotIn('PRIVATE QUESTION', context)
        self.assertIn('Retained answer for followup', context)

    def test_deleted_answer_keeps_question_as_followup_context(self):
        context = self.context([
            {'type': 'request', 'assistant_deleted': True, 'prompt': 'Retained question'},
            {'type': 'delta', 'text': 'PRIVATE ANSWER'},
            {'type': 'done'},
        ])
        self.assertIn('Retained question', context)
        self.assertNotIn('PRIVATE ANSWER', context)

    def test_deleted_both_never_reappear_in_followup_context(self):
        context = self.context([
            {'type': 'request', 'user_deleted': True, 'assistant_deleted': True,
             'prompt': 'PRIVATE QUESTION'},
            {'type': 'delta', 'text': 'PRIVATE ANSWER'},
            {'type': 'done'},
        ])
        self.assertNotIn('PRIVATE QUESTION', context)
        self.assertNotIn('PRIVATE ANSWER', context)


class MessageDeletionPlanTests(unittest.TestCase):
    def rows(self, legacy=False):
        request = {'type': 'request', 'prompt': 'PRIVATE QUESTION',
                   'display_prompt': 'PRIVATE DISPLAY', 'office_references': [{'title': 'PRIVATE FILE'}]}
        if not legacy:
            request.update(user_message_id='user-one', assistant_message_id='assistant-one')
        return [{'id': 10, 'event': request},
                {'id': 11, 'event': {'type': 'status', 'message': 'PRIVATE QUESTION'}},
                {'id': 12, 'event': {'type': 'delta', 'text': 'PRIVATE ANSWER'}},
                {'id': 13, 'event': {'type': 'done', 'session_id': 'native-task'}},
                {'id': 20, 'event': {'type': 'request', 'prompt': 'Next question',
                                     'user_message_id': 'user-two', 'assistant_message_id': 'assistant-two'}},
                {'id': 21, 'event': {'type': 'delta', 'text': 'Next answer'}}]

    def apply(self, rows, plan):
        _, _, replacements, removals = plan
        return [{'id': row['id'], 'event': replacements.get(row['id'], row['event'])}
                for row in rows if row['id'] not in removals]

    def test_question_deletion_removes_prompt_references_and_tool_echo_but_keeps_answer(self):
        original = self.rows()
        untouched = copy.deepcopy(original)
        plan = plan_deletion(original, 'user-one')
        self.assertEqual(plan[:2], (10, 'user'))
        remaining = self.apply(original, plan)
        self.assertEqual(original, untouched, 'Pure planner must not mutate saved input')
        self.assertNotIn('PRIVATE QUESTION', str(remaining))
        self.assertNotIn('PRIVATE DISPLAY', str(remaining))
        self.assertNotIn('PRIVATE FILE', str(remaining))
        self.assertIn('PRIVATE ANSWER', str(remaining))
        self.assertIn('Next question', str(remaining))
        self.assertIn('Next answer', str(remaining))
        self.assertNotIn('native-task', str(remaining))

    def test_answer_deletion_preserves_question_and_removes_all_answer_events(self):
        plan = plan_deletion(self.rows(), 'assistant-one')
        self.assertEqual(plan[:2], (10, 'assistant'))
        remaining = self.apply(self.rows(), plan)
        self.assertIn('PRIVATE QUESTION', str(remaining))
        self.assertNotIn('PRIVATE ANSWER', str(remaining))
        self.assertEqual(set(plan[3]), {11, 12, 13})
        self.assertTrue(remaining[0]['event']['assistant_deleted'])

    def test_legacy_message_ids_are_stable_and_can_delete_either_role(self):
        rows = self.rows(legacy=True)
        self.assertEqual(message_ids(rows[0]), ('history-10-user', 'history-10-assistant'))
        self.assertEqual(plan_deletion(rows, 'history-10-user')[:2], (10, 'user'))
        self.assertEqual(plan_deletion(rows, 'history-10-assistant')[:2], (10, 'assistant'))
        self.assertEqual(message_ids(rows[0]), message_ids(copy.deepcopy(rows[0])))

    def test_deleting_both_roles_in_either_order_is_idempotent(self):
        for first, second in [('user-one', 'assistant-one'), ('assistant-one', 'user-one')]:
            with self.subTest(first=first):
                rows = self.apply(self.rows(), plan_deletion(self.rows(), first))
                rows = self.apply(rows, plan_deletion(rows, second))
                self.assertNotIn('PRIVATE QUESTION', str(rows))
                self.assertNotIn('PRIVATE ANSWER', str(rows))
                self.assertTrue(rows[0]['event']['user_deleted'])
                self.assertTrue(rows[0]['event']['assistant_deleted'])
                self.assertEqual(rows, self.apply(rows, plan_deletion(rows, first)))
                self.assertEqual(rows, self.apply(rows, plan_deletion(rows, second)))

    def test_missing_message_does_not_match_another_turn(self):
        with self.assertRaises(HTTPException) as raised:
            plan_deletion(self.rows(), 'nonexistent')
        self.assertEqual(raised.exception.status_code, 404)


class MessageBlobErasureTests(unittest.TestCase):
    def client(self, pages):
        client = Mock()
        client.get_paginator.return_value.paginate.return_value = pages
        client.delete_objects.return_value = {}
        client.head_object.return_value = {}
        return client

    def test_deletes_exact_object_versions_and_markers_without_prefix_siblings(self):
        client = self.client([{'Versions': [
            {'Key': 'target', 'VersionId': 'v1'},
            {'Key': 'target-other', 'VersionId': 'sibling'},
        ], 'DeleteMarkers': [{'Key': 'target', 'VersionId': 'marker'}]},
            {'Versions': [{'Key': 'target', 'VersionId': 'v2'}]}])
        _erase_object(client, 'bucket', 'target')
        client.get_paginator.assert_called_once_with('list_object_versions')
        client.get_paginator.return_value.paginate.assert_called_once_with(Bucket='bucket', Prefix='target')
        self.assertEqual(client.delete_objects.call_count, 2)
        erased = [item for call in client.delete_objects.call_args_list
                  for item in call.kwargs['Delete']['Objects']]
        self.assertEqual(erased, [{'Key': 'target', 'VersionId': 'v1'},
                                  {'Key': 'target', 'VersionId': 'marker'},
                                  {'Key': 'target', 'VersionId': 'v2'}])
        client.delete_object.assert_not_called()

    def test_unversioned_object_still_deleted_when_only_prefix_siblings_found(self):
        client = self.client([{'Versions': [{'Key': 'target-other', 'VersionId': 'sibling'}]}])
        _erase_object(client, 'bucket', 'target')
        client.delete_objects.assert_not_called()
        client.delete_object.assert_called_once_with(Bucket='bucket', Key='target')

    def test_object_version_batches_obey_storage_service_limit(self):
        client = self.client([])
        # A paginator may return arbitrary page sizes; only deletion batches are bounded.
        versions = [{'Key': 'target', 'VersionId': str(index)} for index in range(1001)]
        client.get_paginator.return_value.paginate.return_value = [{'Versions': versions}]
        _erase_object(client, 'bucket', 'target')
        self.assertEqual([len(call.kwargs['Delete']['Objects'])
                          for call in client.delete_objects.call_args_list], [1000, 1])

    def test_partial_remote_failure_is_raised_for_retry(self):
        client = self.client([{'Versions': [{'Key': 'target', 'VersionId': 'v1'}]}])
        client.delete_objects.return_value = {'Errors': [{'Key': 'target', 'Code': 'AccessDenied'}]}
        with self.assertRaises(OSError):
            _erase_object(client, 'bucket', 'target')

    def test_missing_current_version_still_erases_historical_versions(self):
        from botocore.exceptions import ClientError
        client = self.client([{'Versions': [{'Key': 'target', 'VersionId': 'older'}]}])
        client.head_object.side_effect = ClientError({'Error': {'Code': '404'}}, 'HeadObject')
        _erase_object(client, 'bucket', 'target')
        client.delete_objects.assert_called_once_with(
            Bucket='bucket', Delete={'Objects': [{'Key': 'target', 'VersionId': 'older'}]})

    def test_head_permission_denied_is_raised_without_pretending_erasure(self):
        from botocore.exceptions import ClientError
        client = self.client([])
        client.head_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'HeadObject')
        with self.assertRaises(ClientError):
            _erase_object(client, 'bucket', 'target')
        client.delete_object.assert_not_called()
        client.delete_objects.assert_not_called()

    def test_remote_listing_failure_is_not_reported_as_success(self):
        client = self.client([])
        client.get_paginator.return_value.paginate.side_effect = OSError('storage unavailable')
        with self.assertRaises(OSError):
            _erase_object(client, 'bucket', 'target')
        client.delete_object.assert_not_called()


class DeleteMessageFunctionTests(unittest.TestCase):
    def test_delete_message_conversation_not_found(self):
        from app.message_deletion import delete_message
        with patch('app.sessions.get_session', side_effect=FileNotFoundError()):
            with self.assertRaises(HTTPException) as ctx:
                delete_message('alice', 'bad-session', 'msg-1')
            self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_message_already_deleted_or_running_job(self):
        from app.message_deletion import delete_message
        mock_db = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.sessions.get_session', return_value={'id': 's1'}), \
             patch('app.sessions.storage_scope', return_value='session:s1'), \
             patch('app.postgres_storage.ensure_schema'), \
             patch('app.job_queue._connect', return_value=mock_ctx), \
             patch('app.postgres_storage._lock'):
            # Deleted conversation
            mock_db.execute.side_effect = [
                None,  # lock
                MagicMock(fetchone=lambda: True),  # bob_deleted_conversations
            ]
            with self.assertRaises(HTTPException) as ctx:
                delete_message('alice', 's1', 'msg-1')
            self.assertEqual(ctx.exception.status_code, 404)

            # Running job
            mock_db.execute.side_effect = [
                None,  # lock
                MagicMock(fetchone=lambda: False),  # bob_deleted_conversations
                MagicMock(fetchone=lambda: True),  # running job
            ]
            with self.assertRaises(HTTPException) as ctx:
                delete_message('alice', 's1', 'msg-1')
            self.assertEqual(ctx.exception.status_code, 409)

    def test_delete_message_success(self):
        from app.message_deletion import delete_message
        mock_db = MagicMock()
        rows = [
            {'id': 1, 'event': {'type': 'request', 'user_message_id': 'u1', 'assistant_message_id': 'a1', 'prompt': 'hi'}},
            {'id': 2, 'event': {'type': 'delta', 'text': 'hello'}},
            {'id': 3, 'event': {'type': 'done'}},
        ]

        def router(query, *args):
            q = str(query)
            m = MagicMock()
            if 'bob_deleted_conversations' in q:
                m.fetchone.return_value = None
            elif 'bob_jobs WHERE workspace_key=' in q:
                m.fetchone.return_value = None
            elif 'FROM bob_conversation_history' in q and 'SELECT id,event' in q:
                m.fetchall.return_value = rows
            elif 'to_regclass' in q:
                m.fetchone.return_value = {'name': 'bob_answer_feedback'}
            return m

        mock_db.execute.side_effect = router
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        from pathlib import Path
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            temp_path = Path(td)
            mock_root_ctx = MagicMock()
            mock_root_ctx.__enter__.return_value = temp_path

            with patch('app.sessions.get_session', return_value={'id': 's1'}), \
             patch('app.sessions.storage_scope', return_value='session:s1'), \
             patch('app.sessions._root', return_value=temp_path), \
             patch('app.postgres_storage.ensure_schema'), \
             patch('app.job_queue._connect', return_value=mock_ctx), \
             patch('app.postgres_storage._lock'), \
             patch('app.postgres_storage.delete_scope'), \
             patch('app.postgres_storage.temporary_tree', return_value=mock_root_ctx), \
             patch('app.job_queue.session_unique_bob_prompts', return_value=set()), \
             patch('app.blob_storage.purge_message_caches', return_value=False):
                res = delete_message('alice', 's1', 'u1')
                self.assertTrue(res['deleted'])
                self.assertEqual(res['role'], 'user')


if __name__ == '__main__':
    unittest.main()
