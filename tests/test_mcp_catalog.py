import unittest
from unittest.mock import patch, AsyncMock
from pydantic import ValidationError
from app import mcp_catalog

GA = '11111111-1111-4111-8111-111111111111'
GB = '22222222-2222-4222-8222-222222222222'


class MCPCatalogTests(unittest.TestCase):
    def test_administrators_can_use_enabled_servers_without_grants(self):
        item = {'enabled': True, 'access_mode': 'users', 'users': ['alice']}
        self.assertTrue(mcp_catalog.permitted(item, {}, 'alice'))
        self.assertTrue(mcp_catalog.permitted(item, {'is_admin': True}, 'admin'))
        self.assertFalse(mcp_catalog.permitted({**item, 'enabled': False}, {}, 'alice'))
        self.assertFalse(mcp_catalog.permitted({**item, 'enabled': False}, {'is_admin': True}, 'admin'))
        self.assertFalse(mcp_catalog.permitted(item, None, 'admin'))
        groups = {'enabled': True, 'access_mode': 'groups', 'knowledge_base': 'company', 'audience': GA}
        self.assertFalse(mcp_catalog.permitted(groups, {'groups': [GB]}, 'alice'))
        self.assertTrue(mcp_catalog.permitted(groups, {'groups': [GA]}, 'alice'))

    def test_credentials_only_materialized_into_trusted_targets(self):
        item = mcp_catalog.DEFAULTS[0].model_dump()
        config = mcp_catalog.assemble(item, {'token': 'private'})
        self.assertEqual(config['headers']['Authorization'], 'Bearer private')
        self.assertNotIn('private', config['httpURL'])
        for credentials in ({}, {'token': 'secret\r\ninjected'}, {'token': 'secret', 'url': 'https://evil.example'}):
            with self.assertRaises(ValueError):
                mcp_catalog.assemble(item, credentials)

    def test_duplicate_targets_and_credentials_in_urls_rejected(self):
        item = mcp_catalog.DEFAULTS[0].model_dump()
        duplicate = {**item, 'fields': [*item['fields'], {**item['fields'][0], 'key': 'other', 'target': 'authorization'}]}
        with self.assertRaises(ValidationError):
            mcp_catalog.Template.model_validate(duplicate)
        with self.assertRaises(ValidationError):
            mcp_catalog.Template.model_validate({**item, 'url': 'https://example.com/mcp?token=secret'})

    def test_local_credentials_in_environment(self):
        config = mcp_catalog.assemble(mcp_catalog.DEFAULTS[1].model_dump(), {'token': 'private'})
        self.assertEqual(config['env'], {'MONDAY_TOKEN': 'private'})
        self.assertEqual(config['command'], 'mcp-server-monday-api')

    def test_groups_and_users_can_be_granted_together(self):
        item = {'access_mode': 'grants', 'groups': [GA], 'users': ['bob'], 'enabled': True}
        self.assertTrue(mcp_catalog.permitted(item, {'groups': [GA]}, 'alice'))
        self.assertTrue(mcp_catalog.permitted(item, {'groups': [GB]}, 'bob'))
        self.assertTrue(mcp_catalog.permitted(item, {'is_admin': True}, 'admin'))
        self.assertFalse(mcp_catalog.permitted({**item, 'groups': [], 'users': []}, {'groups': [GA]}, 'alice'))

    def test_legacy_restricted_audiences_remain_exact(self):
        item = {'access_mode': 'groups', 'knowledge_base': 'company', 'audience': GA}
        groups = mcp_catalog.access_groups(item)
        self.assertEqual(groups, [GA])
        for memberships in ([], [GA], [GB]):
            profile = {'groups': memberships}
            self.assertEqual(mcp_catalog.permitted(item, profile, 'alice'), mcp_catalog.permitted({**item, 'access_mode': 'grants', 'groups': groups}, profile, 'alice'))

    def test_invalid_groups_rejected_and_new_entries_unassigned(self):
        template = mcp_catalog.Template(id='new', name='New', url='https://example.com/mcp')
        self.assertTrue(mcp_catalog.permitted(template.model_dump(), {'is_admin': True, 'employer': 'buddy'}, 'admin'))
        self.assertFalse(mcp_catalog.permitted(template.model_dump(), {'groups': [GA]}, 'employee'))
        with self.assertRaises(ValidationError):
            mcp_catalog.Template.model_validate({**template.model_dump(), 'groups': ['unknown']})

    def test_provider_presets_match_requested_scope_and_docmost_needs_setup(self):
        presets = {item.id: item for item in mcp_catalog.DEFAULTS}
        self.assertGreaterEqual(len(presets), 15)
        self.assertIn('docmost', presets)
        self.assertIn('microsoft365', presets)
        self.assertEqual(presets['docmost'].auth_mode, 'oauth')
        self.assertEqual(presets['docmost'].url, '')
        self.assertTrue(presets['docmost'].requires_url)
        for excluded in ('postgres', 'mysql', 'redis', 'airtable', 'supabase', 'stripe', 'hubspot', 'intercom', 'slack'):
            self.assertNotIn(excluded, presets)
        for item in mcp_catalog.DEFAULTS[2:]:
            self.assertEqual(item.groups, [])
            self.assertEqual(item.users, [])
        with self.assertRaisesRegex(ValueError, 'administrator'):
            mcp_catalog.assemble(presets['docmost'].model_dump(), {})

    def test_native_microsoft_cannot_be_repointed_and_keeps_user_token_identity(self):
        from pathlib import Path
        item = next(item for item in mcp_catalog.DEFAULTS if item.id == 'microsoft365').model_dump()
        with self.assertRaises(ValidationError):
            mcp_catalog.Template.model_validate({**item, 'command': 'other-command'})
        with patch('app.microsoft_auth._user_token_file', return_value=Path('/private/alice/microsoft.json')):
            config = mcp_catalog.native_microsoft_config('alice')
        self.assertEqual(config['env']['BOB_MICROSOFT_TOKEN_FILE'], '/private/alice/microsoft.json')
        self.assertEqual(config['args'], ['-m', 'app.mcp_microsoft'])

    def test_oauth_fixed_login_query_and_secret_environment_prefix(self):
        item = {'id': 'provider', 'name': 'Provider', 'url': 'https://example.com/mcp?login', 'auth_mode': 'oauth'}
        self.assertEqual(mcp_catalog.Template(**item).url, item['url'])
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{**item, 'url': 'https://example.com/mcp?token=secret'})
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{**item, 'oauth_client_secret_env': 'DATABASE_URL'})


class HealthCheckTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_check_supplies_cwd_and_never_returns_credentials(self):
        with patch.object(mcp_catalog, 'allowed_connections', return_value={'catalog-github': {'httpURL': 'https://example.com'}}), patch('app.mcp_health.probe_mcp', new_callable=AsyncMock, return_value={'status': 'working'}) as probe:
            result = await mcp_catalog.check_template('github', {'username': 'alice'})
        self.assertEqual(result['status'], 'working')
        self.assertIn('cwd', probe.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
