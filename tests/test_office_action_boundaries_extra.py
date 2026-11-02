"""Office action boundaries: synthetic in-memory data and no external storage."""
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from buddy_office import office, office_app_actions as actions
from app import job_queue


class OfficeActionBoundaryTests(unittest.TestCase):
    def test_list_filters_before_pagination_and_binds_caller(self):
        folder = uuid4()
        files = [
            {'id': 'one', 'name': 'REPORT January.docx', 'folder_id': str(folder)},
            {'id': 'two', 'name': 'report February.docx', 'folder_id': str(folder)},
            {'id': 'three', 'name': 'Report Other.docx', 'folder_id': None},
        ]
        with patch.object(office, 'files', return_value={'items': files}) as fetch:
            result = actions.execute('alice', 'list', {'query': ' report ', 'folder_id': str(folder), 'limit': 1, 'offset': 1})
        fetch.assert_called_once_with(user={'username': 'alice'})
        self.assertEqual(result['total'], 2)
        self.assertEqual(result['items'][0]['url'], '/office/files/two')
        self.assertIsNone(result['next_offset'])

    def test_read_and_info_reject_unexpected_arguments_and_fix_user(self):
        file_id = str(uuid4())
        with patch.object(office, 'file_info', return_value={'id': file_id}) as info:
            self.assertEqual(actions.execute('alice', 'info', {'file_id': file_id})['id'], file_id)
        self.assertEqual(info.call_args.kwargs['user'], {'username': 'alice'})
        for operation in ('read', 'info'):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                actions.execute('alice', operation, {'file_id': file_id, 'username': 'bob'})

    def test_save_validates_representation_and_size_before_storage(self):
        with patch.object(office, 'store_new') as store, patch.object(office, 'MAX_BYTES', 4):
            for args in ({'name': 'x.html'}, {'name': 'x.html', 'content': 'x', 'content_base64': 'eA=='},
                         {'name': 'x.html', 'content': '12345'}, {'name': 'x.html', 'content_base64': '%%%'}):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    actions._execute('alice', 'save', args)
            store.assert_not_called()

    def test_new_write_is_saved_once_and_receipt_recorded(self):
        db = MagicMock()
        db.__enter__.return_value = db
        db.execute.return_value.fetchone.return_value = None
        key = 'a' * 64
        with patch.object(office, 'ensure_schema'), patch.object(job_queue, '_connect', return_value=db), \
             patch.object(office, 'store_new', return_value={'id': 'new-file'}) as store:
            result = actions.execute('alice', 'save', {'name': 'x.html', 'content': '<p>x</p>', 'action_key': key})
        self.assertEqual(result['url'], '/office/files/new-file')
        store.assert_called_once_with('alice', 'x.html', b'<p>x</p>', None, db=db)
        self.assertTrue(any('INSERT INTO office.bob_app_action_receipts' in call.args[0] for call in db.execute.call_args_list))

    def test_write_and_chat_intent_keys_are_required(self):
        for operation, arguments in [('save', {'name': 'x', 'content': 'x'}),
                                     ('save_chat', {'action_key': 'a' * 64, 'name': 'x', 'content': 'x'})]:
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                actions.execute('alice', operation, arguments)


if __name__ == '__main__':
    unittest.main()
