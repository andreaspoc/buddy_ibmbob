"""Release contracts: plugin images contain only their own feature package."""
import importlib
import importlib.util
import os
from pathlib import Path
import unittest


class PackageContracts(unittest.TestCase):
    def test_installed_distribution_and_legacy_names_share_module_state(self):
        service = os.environ['BUDDY_PLUGIN_SERVICE']
        module = 'office' if service == 'office' else 'community'
        packaged = importlib.import_module(f'buddy_{service}.{module}')
        legacy = importlib.import_module('app.' + module)
        self.assertIs(packaged, legacy)
        self.assertEqual(importlib.import_module(f'buddy_{service}').__version__, '1.1.0')

    def test_other_feature_is_not_installed(self):
        other = 'people' if os.environ['BUDDY_PLUGIN_SERVICE'] == 'office' else 'office'
        self.assertIsNone(importlib.util.find_spec('buddy_' + other))

    def test_office_assets_belong_to_the_office_package(self):
        if os.environ['BUDDY_PLUGIN_SERVICE'] != 'office':
            self.skipTest('Office assets are not part of the people image')
        import buddy_office
        static = Path(buddy_office.__file__).parent / 'static'
        for path in ('blank.pptx', 'office/bob-provider.js', 'office-bridge/config.json'):
            self.assertTrue((static / path).is_file())
