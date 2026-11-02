"""Unit tests for app.mcp_access registry and access control policies."""
import os
import unittest
from unittest.mock import MagicMock, patch

from app import mcp_access

GA = '11111111-1111-4111-8111-111111111111'
GB = '22222222-2222-4222-8222-222222222222'


class MCPAccessUnitTests(unittest.TestCase):
    def setUp(self):
        mcp_access._schema_database = None

    def test_ensure_schema_and_seed(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.return_value = ('source1',)
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch.dict(os.environ, {'DATABASE_URL': 'postgres://test'}), \
             patch('app.mcp_access._connect', return_value=mock_ctx):
            mcp_access.ensure_schema()
            # calling again hits cache
            mcp_access.ensure_schema()

            mcp_access.seed('source1', {'srv1': {'command': 'cat'}, 'srv2': 'invalid'}, deleted={'srv1'})
            mock_db.execute.assert_called()

    def test_permitted(self):
        self.assertTrue(mcp_access.permitted({'is_admin': True}, 'company', 'both'))
        self.assertTrue(mcp_access.permitted({'is_admin': True}, 'company', GA))
        user = {'is_admin': False, 'groups': [GA]}
        self.assertTrue(mcp_access.permitted(user, 'company', 'both'))
        self.assertTrue(mcp_access.permitted(user, 'company', GA))
        self.assertFalse(mcp_access.permitted(user, 'company', GB))
        self.assertFalse(mcp_access.permitted({'is_admin': False, 'groups': []}, 'company', GA))
        self.assertFalse(mcp_access.permitted(None, 'company', 'both'))

    def test_summary_and_transports(self):
        profile = {'is_admin': True}
        # stdio
        row_stdio = ('srv_stdio', {'command': 'ls'}, 'company', 'both')
        s = mcp_access.summary(row_stdio, profile)
        self.assertEqual(s['transport'], 'stdio')
        self.assertEqual(s['target'], 'ls')

        # http
        row_http = ('srv_http', {'httpURL': 'https://user:pass@example.com/mcp?token=xyz#frag'}, 'company', 'both')
        s = mcp_access.summary(row_http, profile)
        self.assertEqual(s['transport'], 'http')
        self.assertEqual(s['target'], 'https://example.com/mcp')

        # sse with invalid url
        row_sse = ('srv_sse', {'url': 'http://[invalid'}, 'company', 'both')
        s = mcp_access.summary(row_sse, profile)
        self.assertEqual(s['transport'], 'sse')
        self.assertEqual(s['target'], '')

    def test_configured_providers_and_catalog_and_preview(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchall.return_value = [
            ('domost-mcp', {'httpURL': 'https://docmost.example.com'}, 'company', 'both'),
            ('brave_search', {'command': 'brave'}, 'company', 'both'),
            ('custom', {'disabled': True, 'command': 'cmd'}, 'company', 'both'),
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.mcp_access._connect', return_value=mock_ctx), \
             patch('app.mcp_access.knowledge_access', return_value={'is_admin': True}):
            providers = mcp_access.configured_providers('alice')
            self.assertIn('docmost', providers)
            self.assertIn('brave-search', providers)

            cat = mcp_access.catalog('alice', include_all=True)
            self.assertEqual(len(cat), 3)

            prev = mcp_access.preview({'is_admin': True, 'employer': 'buddy', 'project_team': False})
            self.assertEqual(len(prev), 3)

    def test_allowed_servers(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchall.return_value = [
            ('microsoft365', {'command': 'ms'}, 'company', 'both'),
            ('custom', {'command': 'c'}, 'company', 'both'),
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.mcp_access._connect', return_value=mock_ctx), \
             patch('app.mcp_access.knowledge_access', return_value={'is_admin': True}), \
             patch('app.mcp_catalog.native_policy_active', return_value=True), \
             patch('app.mcp_catalog.allowed_connections', return_value={'cat_srv': {'url': 'http://cat'}}):
            servers = mcp_access.allowed_servers('alice')
            self.assertNotIn('microsoft365', servers)
            self.assertIn('custom', servers)
            self.assertIn('cat_srv', servers)
            self.assertEqual(mcp_access.get_authorized_server('alice', 'custom'), {'command': 'c'})

    def test_admin_checks(self):
        with patch('app.mcp_access.knowledge_access', return_value={'is_admin': False}):
            with self.assertRaises(PermissionError):
                mcp_access._administrator('bob')

    def test_create_mcp(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.return_value = None  # no existing
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.mcp_access._connect', return_value=mock_ctx), \
             patch('app.mcp_access.knowledge_access', return_value={'is_admin': True}):
            # invalid audience
            with self.assertRaises(ValueError):
                mcp_access.create('admin', 'test', {}, knowledge_base='invalid')

            res = mcp_access.create('admin', 'new_srv', {'command': 'run'}, knowledge_base='company', audience='both')
            self.assertEqual(res['name'], 'new_srv')

            # existing conflict
            mock_db.execute.return_value.fetchone.return_value = (False,)  # deleted=False
            with self.assertRaises(FileExistsError):
                mcp_access.create('admin', 'new_srv', {'command': 'run'})

    def test_update_mcp(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.return_value = ('srv1', {'keep': 1, 'command': 'old'}, 'company', 'both')
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.mcp_access._connect', return_value=mock_ctx), \
             patch('app.mcp_access.knowledge_access', return_value={'is_admin': True}):
            res = mcp_access.update('admin', 'srv1', {'command': 'new'})
            self.assertEqual(res['name'], 'srv1')

            # not found
            mock_db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(KeyError):
                mcp_access.update('admin', 'srv1', {})

    def test_delete_and_set_access(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.return_value = ('srv1', {'command': 'run'}, 'company', 'both')
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.mcp_access._connect', return_value=mock_ctx), \
             patch('app.mcp_access.knowledge_access', return_value={'is_admin': True}):
            # delete brave_search rejected
            with self.assertRaises(ValueError):
                mcp_access.delete('admin', 'brave_search')

            self.assertTrue(mcp_access.delete('admin', 'srv1'))

            # delete not found
            mock_db.execute.return_value.fetchone.return_value = None
            self.assertFalse(mcp_access.delete('admin', 'srv1'))

            # set_access invalid
            with self.assertRaises(ValueError):
                mcp_access.set_access('admin', 'srv1', 'invalid', 'both')

            # set_access not found
            mock_db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(KeyError):
                mcp_access.set_access('admin', 'srv1', 'company', 'both')

            # set_access success
            mock_db.execute.return_value.fetchone.return_value = ('srv1', {'command': 'run'}, 'company', 'both')
            with patch('app.mcp_access.valid_audience', return_value=True):
                res = mcp_access.set_access('admin', 'srv1', 'company', GB)
            self.assertEqual(res['knowledge_base'], 'company')
            self.assertEqual(res['audience'], GB)

    def test_ensure_builtin_and_managed(self):
        mock_db = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.mcp_access._connect', return_value=mock_ctx), \
             patch('app.mcp_access.knowledge_access', return_value={'is_admin': True}):
            mcp_access.ensure_builtin('builtin1', {'command': 'b'})

            with patch.object(mcp_access, '_rows', return_value=[('b1', {'cmd': 1}, 'company', 'both')]):
                managed = mcp_access.get_managed_server('admin', 'b1')
                self.assertIsNotNone(managed)
                conf = mcp_access.admin_config('admin', 'b1')
                self.assertEqual(conf['cmd'], 1)
                self.assertEqual(conf['knowledge_base'], 'company')

                self.assertIsNone(mcp_access.get_managed_server('admin', 'missing'))
                self.assertIsNone(mcp_access.admin_config('admin', 'missing'))


if __name__ == '__main__':
    unittest.main()
