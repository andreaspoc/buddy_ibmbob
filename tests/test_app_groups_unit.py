"""Unit tests for application groups and roles without requiring live DB."""
from contextlib import contextmanager
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from psycopg.errors import UniqueViolation
from pydantic import ValidationError

from app import app_groups


class AppGroupsUnitTests(unittest.TestCase):
    def setUp(self):
        self.admin = {'username': 'alice', 'is_admin': True}
        self.user = {'username': 'bob', 'is_admin': False}

    def test_administrator_dependency(self):
        self.assertEqual(app_groups.administrator(self.admin), self.admin)
        with self.assertRaises(HTTPException) as exc:
            app_groups.administrator(self.user)
        self.assertEqual(exc.exception.status_code, 403)

    def test_schema_execution(self):
        db = MagicMock()
        app_groups.schema(db)
        self.assertGreater(db.execute.call_count, 4)

    def test_has_role(self):
        db = MagicMock()
        # Invalid role
        self.assertFalse(app_groups.has_role(db, 'alice', 'unknown_role'))
        self.assertFalse(app_groups.has_role(db, '', app_groups.ROLE))

        # Dict username vs string
        db.execute.return_value.fetchone.return_value = (1,)
        self.assertTrue(app_groups.has_role(db, {'username': 'alice'}, app_groups.ROLE))
        self.assertTrue(app_groups.has_role(db, 'alice', app_groups.ROLE))

        db.execute.return_value.fetchone.return_value = None
        self.assertFalse(app_groups.has_role(db, 'bob', app_groups.ROLE))

    def test_member_of(self):
        db = MagicMock()
        gid = uuid4()
        self.assertFalse(app_groups.member_of(db, '', gid))

        db.execute.return_value.fetchone.return_value = (1,)
        self.assertTrue(app_groups.member_of(db, {'username': 'alice'}, gid))
        self.assertTrue(app_groups.member_of(db, 'alice', gid))

        db.execute.return_value.fetchone.return_value = None
        self.assertFalse(app_groups.member_of(db, 'bob', gid))

    def test_pydantic_validators(self):
        # Blank name
        with self.assertRaises(ValidationError):
            app_groups.GroupInput(name='   ')
        # Extra fields forbidden
        with self.assertRaises(ValidationError):
            app_groups.GroupInput(name='Valid', extra_field='bad')

        # Roster input duplicate or empty
        with self.assertRaises(ValidationError):
            app_groups.RosterInput(usernames=['alice', 'alice'], expected_revision=1)
        with self.assertRaises(ValidationError):
            app_groups.RosterInput(usernames=[' alice '], expected_revision=1)

    def test_group_helpers(self):
        db = MagicMock()
        gid = uuid4()
        db.execute.return_value.fetchone.return_value = None
        with self.assertRaises(HTTPException) as exc:
            app_groups._group(db, gid)
        self.assertEqual(exc.exception.status_code, 404)

        db.execute.return_value.fetchone.return_value = {'id': str(gid), 'name': 'Admins'}
        row = app_groups._group(db, gid, lock=True)
        self.assertEqual(row['name'], 'Admins')

        # Revision mismatch
        with self.assertRaises(HTTPException) as exc2:
            app_groups._revision({'revision': 1}, 2)
        self.assertEqual(exc2.exception.status_code, 409)

        # Existing users check
        db.execute.return_value.fetchall.return_value = [{'username': 'alice'}]
        with self.assertRaises(HTTPException) as exc3:
            app_groups._existing_users(db, ['alice', 'missing'])
        self.assertEqual(exc3.exception.status_code, 422)

    def test_display(self):
        self.assertEqual(app_groups._display({'username': 'alice', 'display_name': ' Alice '})['display_name'], 'Alice')
        self.assertEqual(app_groups._display({'username': 'kc-1234', 'display_name': 'kc-1234'})['display_name'], 'User')
        self.assertEqual(app_groups._display({'username': 'bob', 'display_name': ''})['display_name'], 'bob')

    def test_user_directory(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        db.execute.return_value.fetchall.return_value = [{'username': 'u1', 'display_name': 'User One', 'email': 'u1@test.com', 'is_admin': False}]
        with patch.object(app_groups, '_connect', mock_conn):
            res = app_groups.user_directory(self.admin)
            self.assertEqual(len(res['items']), 1)
            self.assertFalse(res['truncated'])

    def test_groups_list(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        db.execute.return_value.fetchall.return_value = [{'id': str(uuid4()), 'name': 'Engineers', 'member_count': 5}]
        with patch.object(app_groups, '_connect', mock_conn):
            res = app_groups.groups(self.admin)
            self.assertEqual(len(res['items']), 1)

    def test_create_group(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # Max groups exceeded
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.return_value.fetchone.return_value = {'count': 500}
            with self.assertRaises(HTTPException) as exc:
                app_groups.create_group(app_groups.GroupInput(name='Over limit'), self.admin)
            self.assertEqual(exc.exception.status_code, 422)

        # Success
        with patch.object(app_groups, '_connect', mock_conn):
            gid = str(uuid4())
            db.execute.side_effect = [
                MagicMock(), # lock
                MagicMock(fetchone=lambda: {'count': 10}), # count
                MagicMock(fetchone=lambda: {'id': gid, 'name': 'Devs', 'description': '', 'revision': 1}), # insert
                MagicMock(), # audit
            ]
            res = app_groups.create_group(app_groups.GroupInput(name='Devs'), self.admin)
            self.assertEqual(res['member_count'], 0)
            self.assertEqual(res['name'], 'Devs')

        # Unique violation
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(),
                MagicMock(fetchone=lambda: {'count': 10}),
                UniqueViolation('duplicate'),
            ]
            with self.assertRaises(HTTPException) as exc2:
                app_groups.create_group(app_groups.GroupInput(name='Devs'), self.admin)
            self.assertEqual(exc2.exception.status_code, 409)

    def test_get_group_detail(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        gid = uuid4()
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'id': str(gid), 'name': 'Devs'}),
                MagicMock(fetchall=lambda: [{'username': 'alice', 'display_name': 'Alice', 'is_admin': True, 'email': 'a@a.com'}]),
            ]
            res = app_groups.group(gid, self.admin)
            self.assertEqual(res['name'], 'Devs')
            self.assertEqual(len(res['members']), 1)

    def test_edit_group(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        gid = uuid4()
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'id': str(gid), 'name': 'Old', 'revision': 1}),
                MagicMock(fetchone=lambda: {'id': str(gid), 'name': 'New', 'revision': 2}),
                MagicMock(), # audit
            ]
            res = app_groups.edit_group(gid, app_groups.GroupUpdate(name='New', expected_revision=1), self.admin)
            self.assertEqual(res['name'], 'New')

        # Unique violation
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'id': str(gid), 'name': 'Old', 'revision': 1}),
                UniqueViolation('duplicate'),
            ]
            with self.assertRaises(HTTPException) as exc:
                app_groups.edit_group(gid, app_groups.GroupUpdate(name='New', expected_revision=1), self.admin)
            self.assertEqual(exc.exception.status_code, 409)

    def test_replace_members(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        gid = uuid4()
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'id': str(gid), 'revision': 1}), # _group
                MagicMock(fetchall=lambda: [{'username': 'alice'}, {'username': 'bob'}]), # _existing_users
                MagicMock(), # delete
                MagicMock(), # insert alice
                MagicMock(), # insert bob
                MagicMock(fetchone=lambda: {'relation': 'learning.folder_app_groups'}), # to_regclass 1
                MagicMock(fetchone=lambda: {'relation': 'learning.class_members'}), # to_regclass 2
                MagicMock(), # insert into class_members
                MagicMock(fetchone=lambda: {'id': str(gid), 'revision': 2}), # update group
                MagicMock(), # audit
            ]
            res = app_groups.replace_members(gid, app_groups.RosterInput(usernames=['alice', 'bob'], expected_revision=1), self.admin)
            self.assertEqual(res['member_count'], 2)

    def test_delete_group(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        gid = uuid4()
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'id': str(gid), 'name': 'To Delete', 'revision': 1}),
                MagicMock(), # audit
                MagicMock(), # delete
            ]
            res = app_groups.delete_group(gid, 1, self.admin)
            self.assertTrue(res['deleted'])

    def test_teachers_and_replace_teachers(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'revision': 3}),
                MagicMock(fetchall=lambda: [{'username': 'teacher1', 'display_name': 'T1', 'is_admin': False, 'email': 't@t.com'}]),
            ]
            res = app_groups.teachers(self.admin)
            self.assertEqual(res['revision'], 3)
            self.assertEqual(len(res['items']), 1)

        # Replace teachers uninitialized
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = None
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(HTTPException) as exc:
                app_groups.replace_teachers(app_groups.RosterInput(usernames=['t1'], expected_revision=1), self.admin)
            self.assertEqual(exc.exception.status_code, 503)

        # Replace teachers success
        with patch.object(app_groups, '_connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'revision': 1}),
                MagicMock(fetchall=lambda: [{'username': 't1'}]),
                MagicMock(), # delete
                MagicMock(), # insert
                MagicMock(fetchone=lambda: {'revision': 2}),
                MagicMock(), # audit
            ]
            res2 = app_groups.replace_teachers(app_groups.RosterInput(usernames=['t1'], expected_revision=1), self.admin)
            self.assertEqual(res2['revision'], 2)
            self.assertEqual(res2['usernames'], ['t1'])


if __name__ == '__main__':
    unittest.main()
