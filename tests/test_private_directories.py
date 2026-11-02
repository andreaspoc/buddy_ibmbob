"""Synthetic filesystem attack fixtures; no database or external services."""
import ast
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from contextvars import ContextVar

from app.private_directories import private_directory, scratch_directory


class PrivateDirectoryTests(unittest.TestCase):
    def test_private_directory_rejects_symlinks_and_shared_leaf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'target'
            target.mkdir(mode=0o700)
            link = root / 'link'
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(OSError):
                private_directory(link)
            target.chmod(0o777)
            with self.assertRaises(PermissionError):
                private_directory(target)

    def test_rejects_symlink_and_shared_nonsticky_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(OSError):
                private_directory(root / 'link' / 'child')
            shared = root / 'shared'
            shared.mkdir(mode=0o700)
            shared.chmod(0o777)
            with self.assertRaises(PermissionError):
                private_directory(shared / 'child')
            self.assertFalse((shared / 'child').exists())

    def test_scratch_is_stable_private_and_not_predictable_default(self):
        first = scratch_directory('test-runtime')
        self.assertEqual(first, scratch_directory('test-runtime'))
        self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o700)
        self.assertEqual(first.stat().st_uid, os.geteuid())
        self.assertNotEqual(first.name, 'bob-runtime')

    def test_configured_directory_is_created_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'runtime'
            self.assertEqual(private_directory(target), target)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)

    def test_runtime_root_uses_job_context_then_validated_configuration(self):
        tree = ast.parse(Path('app/postgres_storage.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == 'runtime_root')
        current = ContextVar('test-runtime-root', default=None)
        namespace = dict(os=os, _runtime=current, private_directory=private_directory,
                         scratch_directory=scratch_directory)
        exec(compile(ast.Module(body=[function], type_ignores=[]),
                     'app/postgres_storage.py', 'exec'), namespace)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured = root / 'configured'
            with patch.dict(os.environ, {'BOB_RUNTIME_ROOT': str(configured)}):
                self.assertEqual(namespace['runtime_root'](), configured)
                configured.chmod(0o777)
                with self.assertRaises(PermissionError):
                    namespace['runtime_root']()
                token = current.set(root / 'job-context')
                try:
                    self.assertEqual(namespace['runtime_root'](), root / 'job-context')
                finally:
                    current.reset(token)


class BlobCacheBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Load the actual filesystem helpers without unrelated database imports.
        source = Path('app/blob_storage.py')
        tree = ast.parse(source.read_text())
        nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                 and node.name in {'_cache_dir', '_cache_name', '_write_cache', '_read_cache'}]
        cls.namespace = dict(os=os, Path=Path, stat=stat,
                             private_directory=private_directory, scratch_directory=scratch_directory)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), cls.namespace)

    def test_symlink_entry_cannot_read_or_overwrite_another_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            victim = root / 'victim'
            victim.write_bytes(b'original synthetic content')
            digest = 'a' * 64
            (root / digest).symlink_to(victim)
            with patch.dict(self.namespace, {'_cache_dir': lambda: root}):
                self.namespace['_write_cache'](digest, b'replacement')
                with self.assertRaises(OSError):
                    self.namespace['_read_cache'](digest)
            self.assertEqual(victim.read_bytes(), b'original synthetic content')

    def test_cache_roundtrip_is_private_immutable_and_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict(self.namespace, {'_cache_dir': lambda: root}):
                self.namespace['_write_cache']('b' * 64, b'fixture')
                self.namespace['_write_cache']('b' * 64, b'changed')
                self.assertEqual(self.namespace['_read_cache']('b' * 64), b'fixture')
                with self.assertRaises(ValueError):
                    self.namespace['_write_cache']('../outside', b'invalid')
            self.assertEqual(stat.S_IMODE((root / ('b' * 64)).stat().st_mode), 0o600)

    def test_unsafe_configured_cache_falls_back_to_private_scratch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'target'
            target.mkdir(mode=0o700)
            link = root / 'link'
            link.symlink_to(target, target_is_directory=True)
            with patch.dict(os.environ, {'BOB_BLOB_CACHE_DIR': str(link)}):
                result = self.namespace['_cache_dir']()
            self.assertNotEqual(result, link)
            self.assertNotEqual(result, target)
            self.assertEqual(stat.S_IMODE(result.stat().st_mode), 0o700)
