import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from app import workspace_config as config


class SkillSnapshotTests(unittest.TestCase):
    def test_worker_catalog_uses_only_restored_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'users' / 'alice'
            skill = root / '.bob' / 'skills' / 'analysis' / 'SKILL.md'
            skill.parent.mkdir(parents=True)
            skill.write_text('---\nname: data-buddy\ndescription: Analyze data\n---\nInstructions')
            with patch.object(config, '_root', return_value=root), \
                    patch.object(config.storage, 'list_files', side_effect=AssertionError('database read')), \
                    patch.object(config.storage, 'read_user_file', side_effect=AssertionError('cloud read')):
                self.assertEqual(config.list_skills(restored=True), [
                    {'name': 'data-buddy', 'description': 'Analyze data'}])
                skill.unlink()
                self.assertEqual(config.list_skills(restored=True), [])
