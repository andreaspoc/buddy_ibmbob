"""Folder metadata boundaries; all storage/network operations are mocked."""
from contextlib import contextmanager
from unittest import TestCase, main
from unittest.mock import MagicMock, patch
from uuid import uuid4
from fastapi import HTTPException
from app import office, office_folders as folders


@contextmanager
def connection(db):
    yield db


class FolderTests(TestCase):
    def test_name_validation(self):
        self.assertEqual(folders.clean_name('  Reports  '), 'Reports')
        for value in ('', '   ', '.', '..', 'a/b', 'a\\b', 'x\n', 'x' * 201, None):
            # Trailing whitespace is normalized; embedded control characters rejected.
            if value == 'x\n':
                value = 'x\ny'
            with self.subTest(value=value), self.assertRaises(HTTPException):
                folders.clean_name(value)

    def test_folder_owner_lookup_does_not_reveal_other_users(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = None
        fid = uuid4()
        with self.assertRaises(HTTPException) as failure:
            folders.folder(db, fid, 'alice')
        self.assertEqual(failure.exception.status_code, 404)
        self.assertEqual(db.execute.call_args.args[1], (str(fid), 'alice'))

    def test_create_duplicate_uses_locked_case_insensitive_sibling_check(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = {'id': uuid4()}
        with self.assertRaises(HTTPException) as failure:
            folders.create(db, 'alice', 'REPORTS', None)
        self.assertEqual(failure.exception.status_code, 409)
        self.assertIn('pg_advisory_xact_lock', db.execute.call_args_list[0].args[0])
        sql, args = db.execute.call_args.args
        self.assertIn('lower(name)=lower(%s)', sql)
        self.assertEqual(args[:3], ('alice', None, 'REPORTS'))
        self.assertFalse(any('INSERT' in call.args[0] for call in db.execute.call_args_list))

    def test_create_rejects_foreign_parent_before_insert(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = None
        with self.assertRaises(HTTPException) as failure:
            folders.create(db, 'alice', 'Reports', uuid4())
        self.assertEqual(failure.exception.status_code, 404)
        self.assertFalse(any('INSERT' in call.args[0] for call in db.execute.call_args_list))

    def test_reparent_rejects_self_and_descendant_cycles(self):
        for direct in (True, False):
            fid, child = uuid4(), uuid4()
            db = MagicMock()
            db.execute.return_value.fetchone.side_effect = [
                {'id': fid, 'name': 'Parent', 'parent_id': None},
                {'id': child, 'parent_id': fid},
            ]
            with self.assertRaises(HTTPException) as failure:
                folders.update(db, 'alice', fid, {'parent_id': fid if direct else child})
            self.assertEqual(failure.exception.status_code, 409)
            self.assertFalse(any('UPDATE' in call.args[0] for call in db.execute.call_args_list))

    def test_reparent_to_root_and_rename_keeps_owner(self):
        fid = uuid4(); db = MagicMock()
        db.execute.return_value.fetchone.side_effect = [
            {'id': fid, 'name': 'Before', 'parent_id': uuid4()}, None,
            {'id': fid, 'name': 'After', 'parent_id': None},
        ]
        result = folders.update(db, 'alice', fid, {'parent_id': None, 'name': 'After'})
        self.assertEqual(result['parent_id'], None)
        self.assertEqual(result['name'], 'After')
        self.assertEqual(db.execute.call_args.args[1], ('After', None, str(fid), 'alice'))

    def test_nonempty_delete_rejected_and_empty_delete_metadata_only(self):
        for occupied in (True, False):
            fid = uuid4(); db = MagicMock()
            db.execute.return_value.fetchone.side_effect = [{'id': fid}, {'occupied': occupied}]
            with patch.object(office, 's3') as storage:
                if occupied:
                    with self.assertRaises(HTTPException) as failure:
                        folders.delete(db, 'alice', fid)
                    self.assertEqual(failure.exception.status_code, 409)
                else:
                    self.assertTrue(folders.delete(db, 'alice', fid)['deleted'])
                storage.assert_not_called()
            occupancy_sql = db.execute.call_args_list[2].args[0]
            self.assertIn('office.bob_office_folders', occupancy_sql)
            self.assertIn('office.bob_office_files', occupancy_sql)

    def test_file_move_requires_owner_and_never_rewrites_object(self):
        fid, folder_id = uuid4(), uuid4(); db = MagicMock()
        row = {'id': fid, 'username': 'alice', 'name': 'Report.html', 'extension': 'html',
               'size': 30, 'revision': 2, 'save_sequence': 1, 'created_at': 'now', 'saved_at': 'now',
               'folder_id': folder_id, 'object_key': 'unchanged'}
        db.execute.return_value.fetchone.return_value = row
        with patch.object(office, 'ensure_schema'), patch.object(office.job_queue, '_connect', lambda: connection(db)), \
             patch.object(office, '_file', return_value=row) as lookup, patch.object(folders, 'destination') as dest, \
             patch.object(office, 'put') as put, patch.object(office, 's3') as storage:
            result = office.move_file(fid, office.FileFolder(folder_id=folder_id), {'username': 'alice'})
        self.assertTrue(lookup.call_args.kwargs['require_owner'])
        dest.assert_called_once_with(db, folder_id, 'alice')
        self.assertEqual(result['folder_id'], str(folder_id))
        self.assertEqual(result['revision'], 2)
        self.assertNotIn('object_key=', db.execute.call_args.args[0])
        put.assert_not_called(); storage.assert_not_called()

    def test_shared_summary_hides_owner_private_folder(self):
        row = {'id': uuid4(), 'username': 'alice', 'name': 'Report.pdf', 'extension': 'pdf',
               'size': 30, 'revision': 2, 'save_sequence': 1, 'created_at': 'now', 'saved_at': 'now',
               'folder_id': uuid4(), 'is_owner': False, 'access': 'write'}
        self.assertIsNone(office.summary(row, 'bob')['folder_id'])
        self.assertEqual(office.summary({**row, 'is_owner': True}, 'alice')['folder_id'], str(row['folder_id']))

    def test_upload_invalid_folder_rejected_before_object_write(self):
        db = MagicMock()
        with patch.object(office, 'ensure_schema'), patch.object(office, 'require_storage'), \
             patch.object(office.job_queue, '_connect', lambda: connection(db)), \
             patch.object(folders, 'destination', side_effect=HTTPException(404)), patch.object(office, 'put') as put:
            with self.assertRaises(HTTPException):
                office.store_new('alice', 'Report.html', b'<html><body>report</body></html>', uuid4())
            put.assert_not_called()

    def test_schema_enforces_same_owner_and_sibling_uniqueness(self):
        db = MagicMock(); folders.migrate(db)
        sql = '\n'.join(call.args[0] for call in db.execute.call_args_list)
        self.assertIn('FOREIGN KEY(parent_id,username)', sql)
        self.assertIn('FOREIGN KEY(folder_id,username)', sql)
        self.assertIn('ON DELETE RESTRICT', sql)
        self.assertIn('lower(name)', sql)
        self.assertIn('ADD COLUMN IF NOT EXISTS folder_id', sql)


if __name__ == '__main__':
    main()
