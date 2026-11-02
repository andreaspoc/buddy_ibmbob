import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts import deploy_buddy


class RetainFrontendAssetsTests(unittest.TestCase):
    def test_archives_running_release_into_existing_persistent_mount(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(deploy_buddy, 'ROOT', Path(directory)), \
                 patch.object(deploy_buddy.subprocess, 'run', return_value=SimpleNamespace(stdout='a' * 64 + '\n')), \
                 patch.object(deploy_buddy, 'run') as run:
                deploy_buddy.retain_frontend_assets(['docker', 'compose'])
                archive = Path(directory) / '.bob-private' / 'frontend-assets'
                self.assertTrue(archive.is_dir())
                run.assert_called_once_with(['docker', 'cp', 'a' * 64 + ':/opt/bob-a2a/app/static/dist/assets/.', str(archive)])

    def test_rejects_untrusted_container_identifiers(self):
        for value in ('--help', 'invalid/id', 'a' * 11, 'a' * 65):
            with self.subTest(value=value), \
                 patch.object(deploy_buddy.subprocess, 'run', return_value=SimpleNamespace(stdout=value)), \
                 patch.object(deploy_buddy, 'run') as run:
                with self.assertRaises(ValueError):
                    deploy_buddy.retain_frontend_assets(['docker', 'compose'])
                run.assert_not_called()

    def test_initial_install_has_no_previous_release_to_archive(self):
        with patch.object(deploy_buddy.subprocess, 'run', return_value=SimpleNamespace(stdout='')), \
             patch.object(deploy_buddy, 'run') as run:
            deploy_buddy.retain_frontend_assets(['docker', 'compose'])
            run.assert_not_called()
