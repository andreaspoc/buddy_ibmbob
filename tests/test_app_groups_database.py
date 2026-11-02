"""Application group and role transactions in the disposable test database."""
import os
import unittest
from uuid import UUID, uuid4
from fastapi import HTTPException
from pydantic import ValidationError
from app import app_groups, job_queue


@unittest.skipUnless(os.getenv('BUDDY_ISOLATED_TEST_DB') == '1', 'Requires the isolated PostgreSQL fixture')
class ApplicationGroupsDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.user = {'username': 'fixture-admin', 'is_admin': True}
        self.member = 'fixture-member-' + uuid4().hex[:10]
        self.name = 'fixture-group-' + uuid4().hex[:10]
        self.group_id = None
        with job_queue._connect() as db:
            app_groups.schema(db)
            db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES(%s,%s,false)', (self.member, 'unused'))

    def tearDown(self):
        with job_queue._connect() as db:
            if self.group_id:
                db.execute('DELETE FROM bob_app_groups WHERE id=%s', (str(self.group_id),))
            db.execute('DELETE FROM users WHERE username=%s', (self.member,))

    def test_group_membership_revision_and_delete(self):
        created = app_groups.create_group(app_groups.GroupInput(name=self.name, description='fixture'), self.user)
        self.group_id = UUID(str(created['id']))
        self.assertEqual(created['member_count'], 0)
        updated = app_groups.replace_members(self.group_id, app_groups.RosterInput(usernames=[self.member], expected_revision=1), self.user)
        self.assertEqual(updated['member_count'], 1)
        with job_queue._connect() as db:
            self.assertTrue(app_groups.member_of(db, self.member, self.group_id))
        self.assertEqual(app_groups.group(self.group_id, self.user)['members'][0]['username'], self.member)
        with self.assertRaises(HTTPException) as error:
            app_groups.edit_group(self.group_id, app_groups.GroupUpdate(name='changed', expected_revision=1), self.user)
        self.assertEqual(error.exception.status_code, 409)
        edited = app_groups.edit_group(self.group_id, app_groups.GroupUpdate(name=self.name + '-edited', expected_revision=2), self.user)
        self.assertEqual(edited['revision'], 3)
        self.assertTrue(app_groups.delete_group(self.group_id, 3, self.user)['deleted'])

    def test_roster_rejects_unknown_users_and_duplicate_names(self):
        created = app_groups.create_group(app_groups.GroupInput(name=self.name), self.user)
        self.group_id = UUID(str(created['id']))
        with self.assertRaises(HTTPException) as error:
            app_groups.replace_members(self.group_id, app_groups.RosterInput(usernames=['missing-user'], expected_revision=1), self.user)
        self.assertEqual(error.exception.status_code, 422)
        with self.assertRaises(ValidationError):
            app_groups.RosterInput(usernames=[self.member, self.member], expected_revision=1)
        with self.assertRaises(HTTPException) as duplicate:
            app_groups.create_group(app_groups.GroupInput(name=self.name.upper()), self.user)
        self.assertEqual(duplicate.exception.status_code, 409)


if __name__ == '__main__':
    unittest.main()
