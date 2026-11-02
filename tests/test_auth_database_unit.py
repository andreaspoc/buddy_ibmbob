"""Unit tests for app.auth database operations, user management, and session management."""
import os
import unittest
from unittest.mock import MagicMock, patch
from argon2.exceptions import VerifyMismatchError
from psycopg.errors import UniqueViolation

from app import auth


class AuthDatabaseUnitTests(unittest.TestCase):
    def setUp(self):
        auth._initialized_databases.clear()

    def test_connect_initializes_schema(self):
        mock_conn = MagicMock()
        mock_conn.__enter__.return_value = mock_conn
        mock_conn.execute.return_value.fetchone.return_value = ('initial-administrator-email',)

        with patch.dict(os.environ, {'DATABASE_URL': 'postgres://user:pass@localhost/db'}), \
             patch('psycopg.connect', return_value=mock_conn):
            with auth._connect() as conn:
                self.assertEqual(conn, mock_conn)
            # Second call skips schema initialization
            with auth._connect() as conn:
                self.assertEqual(conn, mock_conn)

    def test_has_users(self):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.side_effect = [('1',), None]
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_conn

        with patch('app.auth._connect', return_value=mock_ctx):
            self.assertTrue(auth.has_users())
            self.assertFalse(auth.has_users())

    def test_create_user_validation(self):
        # Invalid username
        with self.assertRaises(ValueError):
            auth.create_user('123', 'validpassword123')
        with self.assertRaises(ValueError):
            auth.create_user('ab', 'validpassword123')

        # Invalid password length
        with self.assertRaises(ValueError):
            auth.create_user('alice', 'short')

    def test_create_user_success_and_conflict(self):
        mock_conn = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_conn
        mock_hasher = MagicMock()
        mock_hasher.hash.return_value = 'hashed_pw'

        with patch('app.auth._connect', return_value=mock_ctx), \
             patch('app.auth._hasher', mock_hasher):
            user = auth.create_user('alice', 'password12345', admin=True)
            self.assertEqual(user['username'], 'alice')
            self.assertTrue(user['is_admin'])

            # Setup flag already complete raises
            mock_conn.execute.return_value.fetchone.return_value = ('1',)
            with self.assertRaises(ValueError):
                auth.create_user('bob', 'password12345', setup=True)

            # Unique violation raises ValueError
            mock_conn.execute.side_effect = UniqueViolation('duplicate key')
            with self.assertRaises(ValueError):
                auth.create_user('alice', 'password12345')

    def test_authenticate(self):
        mock_conn = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_conn
        mock_hasher = MagicMock()

        with patch('app.auth._connect', return_value=mock_ctx), \
             patch('app.auth._hasher', mock_hasher):
            # User not found
            mock_conn.execute.return_value.fetchone.return_value = None
            self.assertIsNone(auth.authenticate('alice', 'pass'))

            # Password mismatch
            mock_conn.execute.return_value.fetchone.return_value = ('alice', 'hash', True)
            mock_hasher.verify.side_effect = VerifyMismatchError()
            self.assertIsNone(auth.authenticate('alice', 'wrongpass'))

            # Password match
            mock_hasher.verify.side_effect = None
            mock_hasher.verify.return_value = True
            res = auth.authenticate('alice', 'goodpass')
            self.assertEqual(res, {'username': 'alice', 'is_admin': True})

    def test_start_session(self):
        mock_conn = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_conn
        mock_resp = MagicMock()
        mock_req = MagicMock()
        mock_req.url.scheme = 'https'

        with patch('app.auth._connect', return_value=mock_ctx):
            auth.start_session(mock_resp, {'username': 'alice'}, mock_req)
            mock_resp.set_cookie.assert_called_once()
            self.assertTrue(mock_resp.set_cookie.call_args[1]['secure'])

    def test_user_profile(self):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.side_effect = [('Alice Smith', 'alice@example.com'), None]
        mock_conn.execute.return_value.fetchall.side_effect = [[('group-id', 'Engineering')], []]
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_conn

        with patch('app.auth._connect', return_value=mock_ctx):
            prof = auth.user_profile('alice', is_admin=True)
            self.assertEqual(prof['display_name'], 'Alice Smith')
            self.assertEqual(prof['groups'], [{'id': 'group-id', 'name': 'Engineering'}])

            prof2 = auth.user_profile('bob', is_admin=False)
            self.assertEqual(prof2['display_name'], 'bob')
            self.assertIsNone(prof2['email'])
            self.assertEqual(prof2['groups'], [])


if __name__ == '__main__':
    unittest.main()
