"""Local skill and mode lifecycle in temporary, isolated workspaces."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from app import workspace_config as config


class WorkspaceConfigUnitTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='buddy-config-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        environment = patch.dict('os.environ', {'BOB_WORKSPACE': str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)
        token = config._selected_root.set(self.root)
        self.addCleanup(config._selected_root.reset, token)

    def test_skill_create_read_update_and_duplicate(self):
        created = config.create_skill('example-helper', 'Description', 'First instruction')
        self.assertEqual(created['name'], 'example-helper-buddy')
        self.assertEqual(config.get_skill('example-helper-buddy')['instructions'], 'First instruction')
        self.assertIn('example-helper-buddy', {item['name'] for item in config.list_skills()})
        updated = config.update_skill('example-helper-buddy', 'Updated', 'Second instruction')
        self.assertEqual(updated['instructions'], 'Second instruction')
        self.assertEqual(config.get_skill('example-helper-buddy')['description'], 'Updated')
        with self.assertRaises(FileExistsError):
            config.create_skill('example-helper', 'Duplicate', 'Instruction')

    def test_skill_validation_and_missing_descriptor(self):
        for name, instructions in (('../bad', 'text'), ('Bad', 'text'), ('good', '  ')):
            with self.subTest(name=name), self.assertRaises(ValueError):
                config.create_skill(name, 'description', instructions)
        with self.assertRaises(KeyError):
            config.get_skill('missing')

    def test_custom_mode_lifecycle_and_group_validation(self):
        created = config.create_mode('example', 'Example', 'description', 'Role', 'Instructions', [])
        self.assertEqual(created['kind'], 'custom')
        self.assertIn('example', {item['slug'] for item in config.list_modes()})
        with self.assertRaises(FileExistsError):
            config.create_mode('example', 'Duplicate', '', '', '', [])
        with self.assertRaises(ValueError):
            config.create_mode('bad', 'Bad', '', '', '', ['not-a-group'])

    def test_invalid_mode_and_json_files_are_rejected(self):
        path = self.root / '.bob/custom_modes.yaml'
        path.parent.mkdir(parents=True)
        path.write_text('customModes: not-a-list')
        with self.assertRaises(ValueError):
            config.list_modes()
        path.write_text('[]')
        with self.assertRaises(ValueError):
            config._read_json(path, 'entries')

    def test_agent_lifecycle_redacts_credentials_and_preserves_blank_updates(self):
        with patch.object(config, 'mcp_actor', return_value=None):
            agent = config.create_agent('example', {'name': 'Example', 'endpoint': 'https://example.test', 'api_key': 'private'})
            self.assertNotIn('api_key', agent)
            self.assertNotIn('api_key', config.list_agents()[0])
            self.assertEqual(config.get_agent('example')['api_key'], 'private')
            updated = config.update_agent('example', {'name': 'New name', 'api_key': ''})
            self.assertEqual(updated['name'], 'New name')
            self.assertEqual(config.get_agent('example')['api_key'], 'private')
            with self.assertRaises(FileExistsError):
                config.create_agent('example', {})
            config.delete_agent('example')
            self.assertIsNone(config.get_agent('example'))
            with self.assertRaises(KeyError):
                config.delete_agent('example')
        for operation in (lambda: config.create_agent('catalog-reserved', {}),
                          lambda: config.update_agent('catalog-reserved', {}),
                          lambda: config.delete_agent('catalog-reserved')):
            with self.assertRaises(ValueError):
                operation()


if __name__ == '__main__':
    unittest.main()
