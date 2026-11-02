"""Prevent independent releases or first installs from starting unwanted plugins."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('deploy_buddy', Path('scripts/deploy_buddy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentContracts(unittest.TestCase):
    def test_core_only_does_not_activate_plugin_profiles_or_services(self):
        self.assertNotIn('--profile', deploy.configuration([]))
        self.assertEqual(deploy.targets([]), ['bob-agent', 'bob-worker'])

    def test_office_only_does_not_activate_people_worker(self):
        configuration = deploy.configuration(['office'])
        self.assertIn('docker-compose.office.yml', configuration)
        self.assertNotIn('docker-compose.people.yml', configuration)
        self.assertNotIn('people-worker', deploy.targets(['office']))

    def test_single_plugin_release_keeps_all_enabled_routing_but_targets_only_that_plugin(self):
        configuration = deploy.configuration(['office', 'people'], https=True)
        self.assertIn('docker-compose.office.yml', configuration)
        self.assertIn('docker-compose.people.yml', configuration)
        self.assertIn('docker-compose.https.yml', configuration)
        self.assertEqual(deploy.targets(['office', 'people'], only='people'),
                         ['people-plugin', 'people-worker'])
        self.assertEqual(deploy.targets(['office', 'people'], only='office'), ['office-plugin'])

    def test_remote_install_uses_one_remote_base(self):
        configuration = deploy.configuration(['people'], remote=True)
        self.assertIn('docker-compose.remote.yml', configuration)
        self.assertNotIn('docker-compose.yml', configuration)

    def test_decisions_release_preserves_other_plugins_and_renames_saved_choice(self):
        self.assertEqual(deploy.normalized_features(['zen', 'office', 'people', 'projects']),
                         ['decisions', 'office', 'people', 'projects'])
        configuration = deploy.configuration(['zen', 'office'])
        self.assertIn('docker-compose.decisions.yml', configuration)
        self.assertNotIn('docker-compose.zen.yml', configuration)
        self.assertEqual(deploy.targets(['decisions', 'office'], only='decisions'), ['decisions-plugin'])

    def test_projects_release_is_independent_and_retains_existing_plugins(self):
        configuration = deploy.configuration(['office', 'people', 'projects'], https=True)
        self.assertIn('docker-compose.projects.yml', configuration)
        self.assertEqual(deploy.targets(['office', 'people', 'projects'], only='projects'), ['projects-plugin'])
        self.assertIn('projects-plugin', deploy.targets(['projects']))
        self.assertNotIn('office-plugin', deploy.targets(['projects']))
