"""Access checks and bounded search indexing without external services."""
import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from app import index_search, project_agent_access


class ProjectReaderTests(unittest.TestCase):
    def test_admin_bypasses_identity_database(self):
        user = {'username': 'admin', 'is_admin': True}
        with patch.object(project_agent_access.job_queue, '_connect') as connect:
            self.assertIs(project_agent_access.require_reader(user), user)
            connect.assert_not_called()

    def test_reader_requires_configured_issuer_and_verified_identity(self):
        db = MagicMock()
        connect = MagicMock()
        connect.return_value.__enter__.return_value = db
        user = {'username': 'alice'}
        with patch.object(project_agent_access.job_queue, '_connect', connect), patch.dict('os.environ', {'KEYCLOAK_ISSUER': ''}):
            with self.assertRaises(HTTPException) as exc:
                project_agent_access.require_reader(user)
            self.assertEqual(exc.exception.status_code, 403)
            db.execute.assert_not_called()
        with patch.object(project_agent_access.job_queue, '_connect', connect), patch.dict('os.environ', {'KEYCLOAK_ISSUER': 'https://id.example/'}):
            db.execute.return_value.fetchone.side_effect = [{'relation': 'identities'}, None]
            with self.assertRaises(HTTPException):
                project_agent_access.require_reader(user)
            db.execute.return_value.fetchone.side_effect = [{'relation': 'identities'}, (1,)]
            self.assertIs(project_agent_access.require_reader(user), user)
            self.assertEqual(db.execute.call_args.args[1], ('alice', 'https://id.example'))


class IndexSearchTests(unittest.TestCase):
    def test_indexes_only_safe_matching_files_and_guards_concurrent_changes(self):
        rows = [dict(username='alice', scope='user', path=path, sha256='old') for path in
                ('report.txt', '.secret.txt', 'vendor/data.txt', 'stale.txt')]
        db = MagicMock()
        db.execute.return_value.fetchall.return_value = rows
        connect = MagicMock()
        connect.return_value.__enter__.return_value = db
        def get_file(username, scope, path, internal):
            return {'sha256': 'changed' if path == 'stale.txt' else 'old', 'content': b'hello'}
        with patch.object(index_search.storage, 'ensure_schema'), patch.object(index_search.storage, 'get_file', side_effect=get_file) as get, \
             patch.object(index_search.job_queue, '_connect', connect), patch.object(index_search, 'searchable_text', return_value='hello'), redirect_stdout(io.StringIO()) as output:
            index_search.main()
        self.assertEqual([call.args[2] for call in get.call_args_list], ['report.txt', 'stale.txt'])
        updates = [call for call in db.execute.call_args_list if call.args[0].startswith('UPDATE')]
        self.assertEqual(len(updates), 3)
        self.assertEqual([call.args[1][0] for call in updates], ['hello', '', ''])
        self.assertTrue(all('sha256=%s AND search_text IS NULL' in call.args[0] for call in updates))
        self.assertIn('Indexed 3', output.getvalue())


if __name__ == '__main__':
    unittest.main()
