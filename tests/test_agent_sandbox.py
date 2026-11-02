"""Command-policy checks plus a real filesystem isolation probe when supported."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app.agent_sandbox import sandbox_command


class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.work, self.home = self.root / 'work', self.root / 'home'
        self.work.mkdir(); self.home.mkdir()
        self.environment = {'HOME': str(self.home)}

    def command(self, command=('true',)):
        return sandbox_command(command, workspace=self.work, environment=self.environment)

    def test_missing_runtime_fails_closed(self):
        with patch('app.agent_sandbox.shutil.which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'No agent was started'):
                self.command()

    def test_policy_exposes_only_exact_writable_directories_and_sockets(self):
        broker = self.root / 'gateway.sock'
        broker.touch()
        self.environment['BOB_MCP_SOCKET'] = str(broker)
        with patch('app.agent_sandbox.shutil.which', return_value='/usr/bin/bwrap'), patch.object(Path, 'is_socket', return_value=True):
            command = self.command()
        writable = [command[i + 1] for i, item in enumerate(command) if item == '--bind']
        self.assertEqual(writable, [str(self.work), str(self.home)])
        self.assertIn('--unshare-pid', command)
        self.assertIn('--unshare-user', command)
        self.assertIn('--cap-drop', command)
        self.assertIn(str(broker), command)
        self.assertNotIn(str(self.root), command)
        self.assertNotIn('--ro-bind / /', ' '.join(command))

    def test_shared_home_and_symlink_to_privileged_root_denied(self):
        with patch('app.agent_sandbox.shutil.which', return_value='/usr/bin/bwrap'):
            for path in ('/root', '/', '/usr', str(self.work)):
                self.environment['HOME'] = path
                with self.assertRaises(RuntimeError): self.command()
            link = self.root / 'link'; link.symlink_to('/usr')
            self.environment['HOME'] = str(link)
            with self.assertRaises(RuntimeError): self.command()

    def test_only_current_owners_settings_symlink_is_exposed(self):
        settings = self.root / '.bob'; settings.mkdir()
        (self.work / '.bob').symlink_to(settings, target_is_directory=True)
        with patch('app.agent_sandbox.shutil.which', return_value='/usr/bin/bwrap'):
            command = self.command()
            index = command.index(str(settings))
            self.assertEqual(command[index - 1], '--ro-bind')
            (self.work / '.bob').unlink()
            other = self.root / 'other'; other.mkdir()
            (self.work / '.bob').symlink_to(other, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'settings must belong'):
                self.command()

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is not installed on this host')
    def test_real_sibling_read_and_source_write_are_denied(self):
        secret = self.root / 'sibling-secret'
        secret.write_text('fixture-only')
        script = 'test ! -e "$1" && test ! -e /root/.bob && touch "$2/allowed" && ! touch "$3/probe"'
        command = self.command(('/bin/sh', '-c', script, 'probe', str(secret), str(self.work), str(Path(__file__).resolve().parents[1] / 'app')))
        result = subprocess.run(command, capture_output=True, text=True, timeout=10,
                                env={**os.environ, **self.environment})
        if result.returncode and ('Operation not permitted' in result.stderr or 'No permissions to create' in result.stderr):
            self.skipTest('host prohibits required user/mount namespaces')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.work / 'allowed').exists())


if __name__ == '__main__': unittest.main()
