"""Migration safeguards tested without connecting to a production database."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from app import migrate_storage


class MigrationSessionTests(unittest.TestCase):
    def test_dry_run_keeps_local_files_and_does_not_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'users' / 'alice' / 'sessions' / ('a' * 32)
            source.mkdir(parents=True)
            (source / 'note.txt').write_text('keep me')
            db = MagicMock()
            db.execute.return_value.fetchone.return_value = None
            connection = MagicMock()
            connection.return_value.__enter__.return_value = db
            with patch.object(migrate_storage.storage, 'ensure_schema'), \
                 patch.object(migrate_storage.job_queue, '_connect', connection), \
                 patch.object(migrate_storage, '_import_session') as importer:
                migrate_storage.migrate(root)
            importer.assert_not_called()
            self.assertEqual((source / 'note.txt').read_text(), 'keep me')

    def test_active_jobs_block_migration(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = (1,)
        connection = MagicMock()
        connection.return_value.__enter__.return_value = db
        with tempfile.TemporaryDirectory() as directory, patch.object(migrate_storage.storage, 'ensure_schema'), \
             patch.object(migrate_storage.job_queue, '_connect', connection):
            with self.assertRaisesRegex(RuntimeError, 'active jobs'):
                migrate_storage.migrate(Path(directory), apply=True)

    def test_import_recovers_metadata_and_history_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / ('a' * 32)
            root.mkdir()
            (root / '.history.jsonl').write_text('{"role":"user","text":"hello"}\n\n')
            db = MagicMock()
            db.execute.return_value.fetchone.return_value = None
            with patch.object(migrate_storage.storage, 'save_tree') as save:
                scope = migrate_storage._import_session(db, 'alice', root)
            self.assertEqual(scope, 'session:' + root.name)
            save.assert_called_once_with('alice', scope, root, db=db, merge=True)
            inserts = [call for call in db.execute.call_args_list if 'INSERT INTO bob_conversations' in call.args[0]]
            self.assertEqual(json.loads(inserts[0].args[1][2])['title'], 'Recovered conversation')
            history = [call for call in db.execute.call_args_list if 'INSERT INTO bob_conversation_history' in call.args[0]]
            self.assertEqual(json.loads(history[0].args[1][2])['text'], 'hello')

    def test_metadata_mismatch_and_deleted_conversations_are_not_imported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / ('b' * 32)
            root.mkdir()
            metadata = root / '.conversation.json'
            db = MagicMock()
            metadata.write_text(json.dumps({'id': 'different'}))
            with patch.object(migrate_storage.storage, 'save_tree') as save:
                with self.assertRaisesRegex(ValueError, 'ID mismatch'):
                    migrate_storage._import_session(db, 'alice', root)
                db.execute.assert_not_called()
                metadata.write_text(json.dumps({'id': root.name}))
                db.execute.return_value.fetchone.return_value = (1,)
                with self.assertRaisesRegex(ValueError, 'Deleted conversation'):
                    migrate_storage._import_session(db, 'alice', root)
                save.assert_not_called()

    def test_existing_history_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / ('c' * 32)
            root.mkdir()
            (root / '.history.jsonl').write_text('{"text":"new"}\n')
            db = MagicMock()
            db.execute.return_value.fetchone.side_effect = [None, (1,)]
            with patch.object(migrate_storage.storage, 'save_tree'):
                migrate_storage._import_session(db, 'alice', root)
            self.assertFalse(any('INSERT INTO bob_conversation_history' in call.args[0] for call in db.execute.call_args_list))

    def test_migrate_apply_session_and_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            user_dir = root / 'users' / 'alice'
            session_dir = user_dir / 'sessions' / ('d' * 32)
            project_dir = user_dir / 'projects' / ('e' * 32)
            session_dir.mkdir(parents=True)
            project_dir.mkdir(parents=True)
            (session_dir / 'doc.txt').write_text('session file')
            (project_dir / 'code.py').write_text('project file')

            db = MagicMock()
            db.execute.return_value.fetchone.return_value = None
            connection = MagicMock()
            connection.return_value.__enter__.return_value = db

            def mock_get(username, scope, path, internal=True):
                if scope.startswith('session:'):
                    return {'content': b'session file'}
                if scope.startswith('project:'):
                    return {'content': b'project file'}
                return {'content': b''}

            with patch.object(migrate_storage.storage, 'ensure_schema'), \
                 patch.object(migrate_storage.job_queue, '_connect', connection), \
                 patch.object(migrate_storage.storage, 'save_tree'), \
                 patch.object(migrate_storage.storage, '_lock'), \
                 patch.object(migrate_storage.storage, 'get_file', side_effect=mock_get):
                migrate_storage.migrate(root, apply=True, remove_local=False)
            self.assertTrue(session_dir.exists())

    def test_migrate_global(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as home_dir:
            source = Path(directory)
            priv_home = Path(home_dir)
            (source / 'deck.html').write_text('<html>deck</html>')
            (priv_home / 'config.json').write_text('{"setting": true}')

            db = MagicMock()
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: ('alice',)), # owner
                MagicMock(fetchone=lambda: None), # already migrated check
                MagicMock(), # upsert deck
                MagicMock(), # upsert config
                MagicMock(), # insert migration
            ]
            conn = MagicMock()
            conn.return_value.__enter__.return_value = db

            with patch('app.auth._connect', conn), \
                 patch.object(migrate_storage.job_queue, '_connect', conn), \
                 patch.object(migrate_storage.storage, '_upsert'), \
                 patch.object(migrate_storage.storage, 'get_file', side_effect=lambda u, s, p, internal=True: {'content': (source / 'deck.html').read_bytes() if 'deck' in p else (priv_home / 'config.json').read_bytes()}):
                migrate_storage.migrate_global(source, priv_home, apply=True, remove_local=False)
            self.assertTrue((source / 'deck.html').exists())



if __name__ == '__main__':
    unittest.main()
