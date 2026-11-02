"""Unit tests covering app/projects.py storage, zip validation, git operations and routes."""
from contextlib import contextmanager
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import zipfile

from fastapi import HTTPException

from app import projects


class ProjectsStorageTests(unittest.TestCase):
    def setUp(self):
        self.username = 'alice'
        self.project_id = '0123456789abcdef0123456789abcdef'

    def test_list_projects(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        created_dt = MagicMock()
        created_dt.isoformat.return_value = '2026-01-01T00:00:00Z'
        db.execute.return_value.fetchall.return_value = [
            (self.project_id, 'My Project', 'empty', created_dt)
        ]
        with patch('app.projects._connect', mock_conn):
            res = projects.list_projects(self.username)
            self.assertEqual(len(res), 1)
            self.assertEqual(res[0]['name'], 'My Project')

    def test_project_root_checks(self):
        # Invalid hex ID
        with self.assertRaises(HTTPException) as exc1:
            projects.project_root(self.username, 'not-a-valid-hex-id')
        self.assertEqual(exc1.exception.status_code, 404)

        # Not in DB
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.projects._connect', mock_conn):
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(HTTPException) as exc2:
                projects.project_root(self.username, self.project_id)
            self.assertEqual(exc2.exception.status_code, 404)

        # In DB
        with patch('app.projects._connect', mock_conn), patch('app.projects.user_root', return_value=Path('/runtime/users/alice')):
            db.execute.return_value.fetchone.return_value = (1,)
            root = projects.project_root(self.username, self.project_id)
            self.assertEqual(root, Path('/runtime/users/alice/projects/' + self.project_id))

    def test_git_wrapper_error_handling(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # Timeout
            with patch('subprocess.run', side_effect=subprocess.TimeoutExpired(['git'], 120)):
                with self.assertRaises(HTTPException) as exc:
                    projects.git(root, 'status')
                self.assertEqual(exc.exception.status_code, 408)

            # Auth failed
            mock_res_auth = MagicMock(returncode=1, stderr=b'Authentication failed for repo')
            with patch('subprocess.run', return_value=mock_res_auth):
                with self.assertRaises(HTTPException) as exc2:
                    projects.git(root, 'status')
                self.assertEqual(exc2.exception.status_code, 401)

            # Not found
            mock_res_nf = MagicMock(returncode=1, stderr=b'fatal: repository not found')
            with patch('subprocess.run', return_value=mock_res_nf):
                with self.assertRaises(HTTPException) as exc3:
                    projects.git(root, 'status')
                self.assertEqual(exc3.exception.status_code, 404)

            # General error
            mock_res_err = MagicMock(returncode=1, stderr=b'fatal: some other git error')
            with patch('subprocess.run', return_value=mock_res_err):
                with self.assertRaises(HTTPException) as exc4:
                    projects.git(root, 'status')
                self.assertEqual(exc4.exception.status_code, 400)

            # Success
            mock_res_ok = MagicMock(returncode=0, stdout=b'git output')
            with patch('subprocess.run', return_value=mock_res_ok):
                out = projects.git(root, 'status', auth_token='tok123')
                self.assertEqual(out, b'git output')

    def test_validate_zip(self):
        # Oversized
        with self.assertRaises(HTTPException) as exc:
            projects.validate_zip(b'x' * (projects.MAX_ZIP + 1))
        self.assertEqual(exc.exception.status_code, 413)

        # Bad zip
        with self.assertRaises(HTTPException) as exc2:
            projects.validate_zip(b'not a zip file')
        self.assertEqual(exc2.exception.status_code, 400)

        # Unsafe path in zip (e.g. absolute or .. or reserved)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('../escape.txt', 'evil')
        with self.assertRaises(HTTPException) as exc3:
            projects.validate_zip(buf.getvalue())
        self.assertEqual(exc3.exception.status_code, 400)

        # Valid zip
        buf_ok = io.BytesIO()
        with zipfile.ZipFile(buf_ok, 'w') as zf:
            zf.writestr('folder/hello.txt', 'world')
        arch = projects.validate_zip(buf_ok.getvalue())
        self.assertIsNotNone(arch)

    def test_safe_file_and_read_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'sub').mkdir()
            (root / 'sub' / 'test.txt').write_text('hello world')
            (root / 'sub' / 'binary.bin').write_bytes(b'bin\x00data')

            # Empty / dot-dot / reserved
            for bad in ('', '../other', '.git/config', '.bob/test', '/etc/passwd'):
                with self.subTest(bad=bad), self.assertRaises(HTTPException):
                    projects.safe_file(root, bad)

            # Valid safe_file
            sf = projects.safe_file(root, 'sub/test.txt')
            self.assertEqual(sf, root / 'sub' / 'test.txt')

            # read_file success
            res = projects.read_file(root, 'sub/test.txt')
            self.assertEqual(res['content'], 'hello world')

            # read_file not found
            with self.assertRaises(HTTPException) as exc_nf:
                projects.read_file(root, 'missing.txt')
            self.assertEqual(exc_nf.exception.status_code, 404)

            # read_file binary
            with self.assertRaises(HTTPException) as exc_bin:
                projects.read_file(root, 'sub/binary.bin')
            self.assertEqual(exc_bin.exception.status_code, 415)

    def test_files_and_download(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'doc.txt').write_text('content')
            (root / 'hidden_dir').mkdir()
            (root / 'hidden_dir' / 'file.txt').write_text('content')

            file_list = projects.files(root)
            self.assertEqual(len(file_list), 2)

            data = projects.download(root)
            self.assertGreater(len(data), 0)
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                self.assertIn('doc.txt', zf.namelist())

    def test_create_project_empty(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        def fake_git(r, *args, **kwargs):
            if 'init' in args:
                (r / '.git' / 'info').mkdir(parents=True, exist_ok=True)
            return b''

        with tempfile.TemporaryDirectory() as td:
            u_root = Path(td)
            (u_root / '.bob').mkdir()
            with patch('app.projects._connect', mock_conn), \
                 patch('app.projects.user_root', return_value=u_root), \
                 patch('app.projects.storage.save_tree'), \
                 patch('app.projects.git', side_effect=fake_git):
                res = projects.create_project(self.username, 'New Repo', source='empty')
                self.assertEqual(res['name'], 'New Repo')
                self.assertEqual(res['source'], 'empty')

    def test_create_project_git_validation(self):
        # Blank name
        with self.assertRaises(HTTPException) as exc:
            projects.create_project(self.username, '', source='empty')
        self.assertEqual(exc.exception.status_code, 422)

        # Invalid git url host
        with self.assertRaises(HTTPException) as exc2:
            projects.create_project(self.username, 'Git Repo', source='git', url='https://evil.example.com/repo')
        self.assertEqual(exc2.exception.status_code, 400)

        # Invalid git branch
        with self.assertRaises(HTTPException) as exc3:
            projects.create_project(self.username, 'Git Repo', source='git', url='https://github.com/owner/repo', branch='bad;branch')
        self.assertEqual(exc3.exception.status_code, 400)

    def test_stored_helpers(self):
        with patch.object(projects, 'project_root', return_value=Path('/fake/root')), \
             patch('app.projects.storage.list_files', return_value=[{'path': 'README.md', 'size': 12}, {'path': '.git/HEAD', 'size': 5}]):
            res = projects.stored_files(self.username, self.project_id)
            self.assertEqual(len(res), 1)
            self.assertEqual(res[0]['path'], 'README.md')

        # stored_read_file
        with patch.object(projects, 'project_root', return_value=Path('/fake/root')), \
             patch.object(projects, 'safe_file'), \
             patch('app.projects.storage.get_file', return_value={'content': b'Stored text'}):
            rf = projects.stored_read_file(self.username, self.project_id, 'README.md')
            self.assertEqual(rf['content'], 'Stored text')

        # stored_edit_file conflict
        db = MagicMock()
        @contextmanager
        def mock_mutation(u, s):
            yield db

        with patch.object(projects, 'stored_read_file'), \
             patch('app.projects.storage.mutation', side_effect=mock_mutation), \
             patch('app.projects.storage.blob_storage.read', return_value=b'changed by another'):
            db.execute.return_value.fetchone.return_value = {'content': b'changed'}
            with self.assertRaises(HTTPException) as exc:
                projects.stored_edit_file(self.username, self.project_id, 'README.md', 'new text', 'original text')
            self.assertEqual(exc.exception.status_code, 409)

        # stored_publish validation
        with patch.object(projects, 'project_root', return_value=Path('/fake/root')):
            # Non-github url
            with self.assertRaises(HTTPException) as exc_pub:
                projects.stored_publish(self.username, self.project_id, 'https://gitlab.com/repo', 'main', 'token')
            self.assertEqual(exc_pub.exception.status_code, 400)

            # Blank token
            with self.assertRaises(HTTPException) as exc_pub2:
                projects.stored_publish(self.username, self.project_id, 'https://github.com/owner/repo', 'main', '')
            self.assertEqual(exc_pub2.exception.status_code, 422)


if __name__ == '__main__':
    unittest.main()
