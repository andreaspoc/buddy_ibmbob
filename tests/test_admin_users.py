"""Security boundaries for administrator assignments and email invitations."""
import asyncio
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from pydantic import ValidationError
from app import admin_users, keycloak_auth


class AdminUsersTests(TestCase):
    def test_bulk_request_validation(self):
        invalid = [
            {'usernames': [], 'changes': {'is_admin': True}},
            {'usernames': ['a', 'a'], 'changes': {'is_admin': True}},
            {'usernames': ['a'], 'changes': {}},
            {'usernames': ['a'], 'changes': {'is_admin': None}},
            {'usernames': ['a'], 'changes': {'project_team': None}},
            {'usernames': ['a'], 'changes': {'email': 'a@example.com'}},
            {'usernames': ['a'] * 101, 'changes': {'is_admin': True}},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                admin_users.BulkAssignment(**payload)

    def bulk_connection(self, rows, profiles, admin_count=2):
        db = MagicMock()
        def execute(sql, params=None):
            result = MagicMock()
            if 'SELECT username,is_admin' in sql:
                result.fetchall.return_value = rows
            elif 'count(*)' in sql:
                result.fetchone.return_value = (admin_count,)
            return result
        db.execute.side_effect = execute
        @contextmanager
        def connection():
            yield db
        return db, connection

    def test_bulk_last_admin_batch_is_rejected_before_writes(self):
        db, connection = self.bulk_connection([('a', True), ('b', True)], [], 2)
        body = admin_users.BulkAssignment(usernames=['a', 'b'], changes={'is_admin': False})
        with patch.object(admin_users, '_connect', connection), self.assertRaises(HTTPException) as error:
            admin_users.update_users(body, {'username': 'a'})
        self.assertEqual(error.exception.status_code, 409)
        self.assertFalse(any(call.args[0].startswith(('INSERT', 'UPDATE')) for call in db.execute.call_args_list))

    def test_bulk_unknown_user_is_rejected_before_writes(self):
        db, connection = self.bulk_connection([('a', True)], [], 2)
        body = admin_users.BulkAssignment(usernames=['a', 'missing'], changes={'is_admin': True})
        with patch.object(admin_users, '_connect', connection), self.assertRaises(HTTPException) as error:
            admin_users.update_users(body, {'username': 'a'})
        self.assertEqual(error.exception.status_code, 404)
        self.assertFalse(any(call.args[0].startswith(('INSERT', 'UPDATE')) for call in db.execute.call_args_list))

    def test_bulk_role_change_audits_and_skips_unchanged(self):
        db, connection = self.bulk_connection([('a', True), ('b', False)], [], 2)
        body = admin_users.BulkAssignment(usernames=['a', 'b'], changes={'is_admin': True})
        with patch.object(admin_users, '_connect', connection), patch.object(admin_users, 'user_profile', side_effect=lambda name, admin: {'username': name, 'is_admin': admin}):
            result = admin_users.update_users(body, {'username': 'a'})
        self.assertEqual(result['updated'], 1)
        self.assertEqual(len(result['users']), 2)
        queries = db.execute.call_args_list
        update = next(call for call in queries if call.args[0].startswith('UPDATE users'))
        self.assertEqual(update.args[1], (True, 'b'))
        audit = next(call for call in queries if call.args[0].startswith('INSERT INTO bob_access_audit'))
        self.assertTrue(audit.args[1][3].obj['bulk'])
        self.assertEqual(audit.args[1][3].obj['after'], {'is_admin': True})

    def test_bulk_route_uses_administrator_dependency_and_precedes_username(self):
        routes = admin_users.router.routes
        bulk = next(route for route in routes if route.path == '/admin/users/bulk')
        single = next(route for route in routes if route.path == '/admin/users/{username}')
        self.assertLess(routes.index(bulk), routes.index(single))
        self.assertTrue(any(dependency.call is admin_users.administrator for dependency in bulk.dependant.dependencies))

    def test_bulk_write_failure_exits_transaction_without_returning_profiles(self):
        db, _ = self.bulk_connection([('a', False), ('b', False)], [], 1)
        execute = db.execute.side_effect
        def fail_second_write(sql, params=None):
            if sql.startswith('UPDATE users') and params[1] == 'b':
                raise RuntimeError('database write failed')
            return execute(sql, params)
        db.execute.side_effect = fail_second_write
        connection = MagicMock()
        connection.return_value.__enter__.return_value = db
        connection.return_value.__exit__.return_value = False
        body = admin_users.BulkAssignment(usernames=['a', 'b'], changes={'is_admin': True})
        with patch.object(admin_users, '_connect', connection), patch.object(admin_users, 'user_profile') as profile, self.assertRaises(RuntimeError):
            admin_users.update_users(body, {'username': 'a'})
        self.assertIs(connection.return_value.__exit__.call_args.args[0], RuntimeError)
        profile.assert_not_called()

    def test_non_admin_cannot_manage_accounts(self):
        with self.assertRaises(HTTPException) as error:
            asyncio.run(admin_users.administrator({'username': 'staff', 'is_admin': False}))
        self.assertEqual(error.exception.status_code, 403)

    def test_last_admin_cannot_be_removed(self):
        db = MagicMock()
        def execute(sql, params=None):
            result = MagicMock()
            result.fetchone.return_value = (1,) if 'count(*)' in sql else (True,)
            return result
        db.execute.side_effect = execute
        @contextmanager
        def connection():
            yield db
        with patch.object(admin_users, '_connect', connection), self.assertRaises(HTTPException) as error:
            admin_users.update_user('admin', admin_users.Assignment(employer=None, project_team=False, is_admin=False), {'username': 'admin'})
        self.assertEqual(error.exception.status_code, 409)
        self.assertFalse(any('UPDATE users' in call.args[0] for call in db.execute.call_args_list))

    def test_email_normalization_and_invalid_input(self):
        self.assertEqual(admin_users.normalized_email(' STAFF@Example.com '), 'staff@example.com')
        for email in ('not-email', 'x@y', 'a b@example.com', 'x' * 321 + '@example.com'):
            with self.assertRaises(HTTPException):
                admin_users.normalized_email(email)

    def resolve(self, verified, email='staff@example.com', duplicate=False):
        db = MagicMock()
        def execute(sql, params=None):
            result = MagicMock()
            if 'SELECT u.username,u.is_admin' in sql:
                result.fetchone.return_value = ('kc-existing', False)
            elif 'username<>%s' in sql:
                result.fetchone.return_value = (1,) if duplicate else None
            elif 'SELECT 1 FROM bob_admin_email_grants' in sql:
                result.fetchone.return_value = (1,)
            else:
                result.fetchone.return_value = None
            return result
        db.execute.side_effect = execute
        @contextmanager
        def connection():
            yield db
        with patch.object(keycloak_auth, '_connect', connection), patch.object(keycloak_auth, 'issuer', return_value='https://sso.example/realms/company'), patch.object(keycloak_auth, 'user_profile', side_effect=lambda username, admin: {'username':username, 'is_admin':admin}):
            user = keycloak_auth.resolve_identity({'sub':'identity','email':email,'email_verified':verified})
        return user, [call.args[0] for call in db.execute.call_args_list]

    def test_only_boolean_verified_claim_can_grant_administrator(self):
        for verified in (False, 'true', 1, None):
            user, queries = self.resolve(verified)
            self.assertFalse(user['is_admin'])
            self.assertFalse(any('UPDATE users SET is_admin=TRUE' in sql for sql in queries))
        user, queries = self.resolve(True)
        self.assertTrue(user['is_admin'])
        self.assertTrue(any('DELETE FROM bob_admin_email_grants' in sql for sql in queries))

    def test_duplicate_verified_email_does_not_select_an_identity(self):
        user, _ = self.resolve(True, duplicate=True)
        self.assertFalse(user['is_admin'])

    def test_overlong_claim_cannot_match_truncated_email(self):
        user, _ = self.resolve(True, email='x' * 321 + '@example.com')
        self.assertFalse(user['is_admin'])

if __name__ == '__main__':
    import unittest
    unittest.main()
