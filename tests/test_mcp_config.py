"""Transport builders and central registry delegation.

Catalog authorization and legacy migration are covered by test_mcp_access.py
and mcp_registry_integration.py; runtime proxy files by test_mcp_runtime.py.
"""
import unittest
from unittest.mock import patch
from app import workspace_config, mcp_access


class MCPConfigurationTests(unittest.TestCase):
    def values(self, **changes):
        values = dict(transport='http', url='https://docs.example/mcp', command='', args=[],
                      parameters={}, headers={}, env={}, api_key='', api_key_name='', api_key_prefix='')
        values.update(changes)
        return values

    def test_http_builder_merges_parameters_and_keeps_credentials_internal(self):
        values = self.values(url='https://docs.example/mcp?version=1', parameters={'version':'2'},
                             headers={'Custom':'fixture'}, api_key='private-fixture', api_key_prefix='Bearer ')
        config = workspace_config.build_mcp_config(**values)
        self.assertEqual(config, {'httpURL':'https://docs.example/mcp?version=2',
                                 'headers':{'Custom':'fixture','Authorization':'Bearer private-fixture'}})

    def test_sse_and_stdio_builders(self):
        self.assertEqual(workspace_config.build_mcp_config(**self.values(transport='sse')), {'url':'https://docs.example/mcp'})
        config = workspace_config.build_mcp_config(**self.values(transport='stdio', command='python3 -m app.mcp_search', env={'BRAVE_API_KEY': 'fixture'}))
        self.assertEqual(config, {'command':'python3','args':['-m', 'app.mcp_search'],'env':{'BRAVE_API_KEY':'fixture'}})

    def test_invalid_configuration_is_rejected(self):
        for changes in ({'transport':'invalid'}, {'url':'file:///etc/passwd'}, {'transport':'stdio','command':''}, {'transport':'stdio','command':'python3 "server with spaces.py"'},
                        {'headers':{'Authorization':123}}, {'api_key':'fixture','api_key_name':'Invalid\r\nHeader'},
                        {'transport':'stdio','command':'python3','api_key':'fixture','api_key_name':'invalid-name'}):
            with self.assertRaises(ValueError):
                workspace_config.build_mcp_config(**self.values(**changes))

    def test_create_delegates_identity_and_classification_to_registry(self):
        values=self.values()
        expected=workspace_config.build_mcp_config(**values)
        expected['disabled'] = False
        with patch.object(workspace_config,'migrate_mcp_registry'),patch.object(workspace_config,'mcp_actor',return_value='administrator'),patch.object(mcp_access,'create',return_value={'name':'docs'}) as create:
            result=workspace_config.create_mcp('docs',**values,knowledge_base='company',audience='group-id')
            self.assertEqual(result,{'name':'docs'})
            create.assert_called_once_with('administrator','docs',expected,'company','group-id')

    def test_update_delegates_and_preserves_access_when_unspecified(self):
        values=self.values()
        expected=workspace_config.build_mcp_config(**values)
        with patch.object(workspace_config,'migrate_mcp_registry'),patch.object(workspace_config,'mcp_actor',return_value='administrator'),patch.object(mcp_access,'update',return_value={'name':'docs'}) as update:
            workspace_config.update_mcp('docs',**values)
            update.assert_called_once_with('administrator','docs',expected,None,None)

    def test_runtime_configs_are_authorized_for_current_identity(self):
        with patch.object(workspace_config,'migrate_mcp_registry'),patch.object(workspace_config,'mcp_actor',return_value='employee'),patch.object(mcp_access,'allowed_servers',return_value={'docs':{'command':'fixture'}}) as allowed:
            self.assertEqual(workspace_config.effective_mcp_servers(),{'docs':{'command':'fixture'}})
            allowed.assert_called_once_with('employee')
        with patch.object(workspace_config,'migrate_mcp_registry'),patch.object(workspace_config,'mcp_actor',return_value=None),patch.object(mcp_access,'allowed_servers') as allowed:
            self.assertEqual(workspace_config.effective_mcp_servers(),{})
            allowed.assert_not_called()


if __name__=='__main__':
    unittest.main()
