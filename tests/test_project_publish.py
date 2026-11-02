"""Project export validation; no database or GitHub access required."""
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
from app import projects


class ProjectPublishTests(unittest.TestCase):
    def test_snapshot_excludes_metadata_and_pushes_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'src').mkdir()
            (root / 'src' / 'app.py').write_text('print("export")\n')
            for folder in ['.git', '.bob', '.home']:
                (root / folder).mkdir()
                (root / folder / 'private').write_text('private')

            @contextmanager
            def temporary_tree(*args):
                yield root

            original_git = projects.git
            pushes = []

            def git(path, *args, **kwargs):
                if args[0] == 'push':
                    pushes.append((args, kwargs))
                    self.assertEqual(original_git(path, 'ls-files').decode().strip(), 'src/app.py')
                    self.assertFalse((path / '.bob').exists())
                    self.assertFalse((path / '.home').exists())
                    return b''
                return original_git(path, *args, **kwargs)

            with patch.object(projects, 'project_root'), patch.object(projects.storage, 'temporary_tree', temporary_tree), patch.object(projects, 'git', git):
                result = projects.stored_publish('owner', 'id', 'https://github.com/owner/repo', 'export', 'test-token')
            self.assertEqual(result['branch'], 'export')
            self.assertEqual(pushes, [(('push', '--', 'https://github.com/owner/repo', 'HEAD:refs/heads/export'), {'auth_token': 'test-token'})])

    def test_rejects_unsafe_destinations(self):
        with patch.object(projects, 'project_root'):
            for url in ['file:///tmp/repo', 'https://evil.com/o/r', 'https://user:pass@github.com/o/r', 'https://github.com/o/r?x=1']:
                with self.subTest(url=url), self.assertRaises(HTTPException):
                    projects.stored_publish('owner', 'id', url, 'main', 'test-token')
            for branch in ['--all', '', '../main']:
                with self.subTest(branch=branch), self.assertRaises(HTTPException):
                    projects.stored_publish('owner', 'id', 'https://github.com/o/r', branch, 'test-token')


if __name__ == '__main__':
    unittest.main()
