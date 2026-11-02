import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from app import workspace_config as config


class SkillEditTests(unittest.TestCase):
    def test_authenticated_api_edit_persists_and_is_user_scoped(self):
        from fastapi.testclient import TestClient
        from app.auth import current_user
        from app.main import app
        from app import job_queue
        users = ['skilledit' + uuid.uuid4().hex[:12], 'skilledit' + uuid.uuid4().hex[:12]]
        selected = users[0]
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict('os.environ', {'BOB_WORKSPACE': directory}):
            root = Path(directory)
            builtin = root / '.bob/skills/analysis/SKILL.md'
            builtin.parent.mkdir(parents=True)
            builtin.write_text('---\nname: analysis\ndescription: Original description\nuser-invocable: true\n---\nOriginal instructions\n')
            async def authenticated_user():
                config.select_root(root / 'users' / selected)
                return {'username': selected, 'is_admin': False}
            previous = app.dependency_overrides.get(current_user)
            app.dependency_overrides[current_user] = authenticated_user
            try:
                client = TestClient(app)
                self.assertEqual(client.get('/skills/analysis').json()['instructions'], 'Original instructions')
                changes = {'description': 'Edited description', 'instructions': 'Updated instructions'}
                response = client.put('/skills/analysis', json=changes)
                self.assertEqual(response.status_code, 200, response.text)
                # A new client/request reads persisted storage, not response state.
                reloaded = TestClient(app).get('/skills/analysis')
                self.assertEqual(reloaded.json(), dict(changes, name='analysis-buddy'))
                self.assertEqual(client.get('/skills/missing').status_code, 404)
                self.assertEqual(client.put('/skills/missing', json=changes).status_code, 404)
                self.assertEqual(client.get('/skills/invalid_name').status_code, 422)
                self.assertEqual(client.put('/skills/analysis', json={**changes, 'instructions': ' \n'}).status_code, 422)
                selected = users[1]
                self.assertEqual(client.get('/skills/analysis').json()['instructions'], 'Original instructions')
                self.assertIn('Original instructions', builtin.read_text())
            finally:
                if previous is None:
                    app.dependency_overrides.pop(current_user, None)
                else:
                    app.dependency_overrides[current_user] = previous
                config._selected_root.set(None)
                with job_queue._connect() as db:
                    for table in ('bob_storage_files', 'bob_skill_aliases'):
                        db.execute('DELETE FROM '+table+' WHERE username = ANY(%s)', (users,))

    def test_user_override_preserves_shipped_metadata_and_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            shipped = Path(directory) / 'shipped'
            builtin = shipped / '.bob/skills/analysis/SKILL.md'
            builtin.parent.mkdir(parents=True)
            original = b'---\nname: data-analyst\ndescription: Analyze data\nuser-invocable: false\nallowed-tools: [Read, Edit]\n---\nOriginal instructions\n'
            builtin.write_bytes(original)
            saved = {}
            def read(path):
                return saved.get(config.storage.user_file_identity(path))
            def write(path, content, **kwargs):
                saved[config.storage.user_file_identity(path)] = content
            def files(username, scope, **kwargs):
                return [{'path': path} for (user, path) in saved if user == username]
            with patch.dict('os.environ', {'BOB_WORKSPACE': str(shipped)}), \
                    patch.object(config.storage, 'read_user_file', side_effect=read), \
                    patch.object(config.storage, 'write_user_file', side_effect=write), \
                    patch.object(config.storage, 'list_files', side_effect=files), \
                    patch.object(config.storage, 'deleted_skill_folders', return_value=set()), \
                    patch.object(config.storage, 'migrate_skill_names'), \
                    patch.object(config.storage, 'resolve_skill_alias', side_effect=lambda user, name: name):
                alice = Path(directory) / 'users/alice'
                with patch.object(config, '_root', return_value=alice):
                    self.assertEqual(config.get_skill('data-analyst')['instructions'], 'Original instructions')
                    config.update_skill('data-analyst', 'New: "description"\nSecond line', 'Updated instructions')
                    self.assertEqual(config.get_skill('data-analyst')['instructions'], 'Updated instructions')
                    self.assertEqual(config.list_skills()[0]['description'], 'New: "description"\nSecond line')
                    stored = saved[('alice', '.bob/skills/data-buddy/SKILL.md')].decode()
                    self.assertIn('user-invocable: false', stored)
                    self.assertIn('- Read', stored)
                with patch.object(config, '_root', return_value=Path(directory) / 'users/bob'):
                    self.assertEqual(config.get_skill('data-analyst')['instructions'], 'Original instructions')
                self.assertEqual(builtin.read_bytes(), original)

    def test_edit_rejects_missing_invalid_and_empty_instructions(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(config, '_root', return_value=Path(directory)):
            with self.assertRaises(KeyError):
                config.get_skill('missing')
            with self.assertRaises(KeyError):
                config.update_skill('missing', 'Description', 'Instructions')
            for name in ('../escape', '/absolute', 'bad/name'):
                with self.assertRaises(ValueError):
                    config.get_skill(name)
            with self.assertRaises(ValueError):
                config.update_skill('analysis', 'Description', '  \n')


if __name__ == '__main__':
    unittest.main()
