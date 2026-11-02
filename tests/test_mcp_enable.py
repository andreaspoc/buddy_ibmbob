"""Connection enable state survives administrator configuration updates."""
import unittest
from unittest.mock import patch
from app.workspace_config import update_mcp

class MCPEnableTests(unittest.TestCase):
    def test_monday_token_enables_initial_placeholder_and_explicit_state_wins(self):
        values = dict(transport='stdio', url='', command='mcp-server-monday-api', args=[], parameters={}, headers={}, env={}, api_key='test-only', api_key_name='MONDAY_TOKEN', api_key_prefix='')
        with patch('app.workspace_config.migrate_mcp_registry'), patch('app.workspace_config.mcp_actor', return_value='admin'), patch('app.mcp_access.update', side_effect=lambda actor, name, config, base, audience: config):
            self.assertFalse(update_mcp('monday-platform-local', **values)['disabled'])
            self.assertTrue(update_mcp('monday-platform-local', disabled=True, **values)['disabled'])
            self.assertFalse(update_mcp('other', disabled=False, **values)['disabled'])

if __name__ == '__main__':
    unittest.main()
