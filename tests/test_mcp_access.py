import unittest
from unittest.mock import patch
from app import mcp_access

GA = '11111111-1111-4111-8111-111111111111'
GB = '22222222-2222-4222-8222-222222222222'


class RegistryPermissions(unittest.TestCase):
    def test_matrix(self):
        for groups in ([], [GA], [GB], [GA, GB]):
            profile = {'groups': groups}
            for audience in ['both', GA, GB]:
                self.assertEqual(mcp_access.permitted(profile, 'company', audience), audience == 'both' or audience in groups)
        self.assertFalse(mcp_access.permitted({'groups': [GA]}, 'retired', GA))
        self.assertFalse(mcp_access.permitted(None, 'company', 'both'))
        self.assertTrue(mcp_access.permitted({'is_admin': True}, 'company', GB))

    def test_admin_bypasses_audience_and_revocation_applies_immediately(self):
        rows = [('restricted', {'command': 'fixture'}, 'company', GB)]
        profiles = [{'is_admin': True}, {'is_admin': False}]
        with patch.object(mcp_access, '_rows', return_value=rows), patch.object(mcp_access, 'knowledge_access', side_effect=profiles), patch('app.mcp_catalog.allowed_connections', return_value={}):
            self.assertIsNotNone(mcp_access.get_authorized_server('admin', 'restricted'))
            self.assertIsNone(mcp_access.get_authorized_server('admin', 'restricted'))

    def test_duplicate_providers_follow_shared_access_and_enabled_state(self):
        rows = [('domost-mcp', {'httpURL': 'https://example.invalid/mcp'}, 'company', GB),
                ('brave_search', {'command': 'fixture', 'disabled': True}, 'company', 'both')]
        with patch.object(mcp_access, '_rows', return_value=rows), patch.object(mcp_access, 'knowledge_access', return_value={'is_admin': True}):
            self.assertEqual(mcp_access.configured_providers('admin'), {'docmost'})
        with patch.object(mcp_access, '_rows', return_value=rows), patch.object(mcp_access, 'knowledge_access', return_value={'is_admin': False}):
            self.assertEqual(mcp_access.configured_providers('employee'), set())

    def test_catalog_redacts_credentials(self):
        rows = [('private', {'httpURL': 'https://name:password@example.com/mcp?api_key=secret', 'headers': {'Authorization': 'Bearer secret'}, 'env': {'SECRET': 'secret'}}, 'company', GB)]
        with patch.object(mcp_access, '_rows', return_value=rows), patch.object(mcp_access, 'knowledge_access', return_value={'groups': [GB]}):
            result = mcp_access.catalog('employee')
            self.assertEqual(result[0]['target'], 'https://example.com/mcp')
            self.assertNotIn('secret', str(result))
            self.assertNotIn('password', str(result))
            self.assertNotIn('headers', result[0])

    def test_revoked_groups_rechecked(self):
        rows = [('private', {'command': 'python3'}, 'company', GB)]
        profiles = [{'groups': [GB]}, {'groups': []}]
        with patch.object(mcp_access, '_rows', return_value=rows), patch.object(mcp_access, 'knowledge_access', side_effect=profiles):
            self.assertIsNotNone(mcp_access.get_authorized_server('employee', 'private'))
            self.assertIsNone(mcp_access.get_authorized_server('employee', 'private'))

    def test_preview_cannot_bypass_groups_with_admin_flag(self):
        rows = [('private', {'command': 'python3'}, 'company', GB)]
        with patch.object(mcp_access, '_rows', return_value=rows):
            result = mcp_access.preview({'is_admin': True, 'project_team': False, 'employer': 'buddy'})
            self.assertEqual(result, [])

    def test_regular_user_cannot_change_registry(self):
        with patch.object(mcp_access, 'knowledge_access', return_value={'is_admin': False}):
            for action in [lambda: mcp_access.create('employee', 'x', {}), lambda: mcp_access.update('employee', 'x', {}), lambda: mcp_access.delete('employee', 'x'), lambda: mcp_access.set_access('employee', 'x', 'company', 'both'), lambda: mcp_access.admin_config('employee', 'x')]:
                with self.assertRaises(PermissionError):
                    action()


if __name__ == '__main__':
    unittest.main()
