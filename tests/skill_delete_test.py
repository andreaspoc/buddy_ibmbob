"""Disposable account fixtures verify deletion across storage and default seeding."""
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from app import workspace_config as config, postgres_storage as storage, job_queue


class SkillDeleteTests(unittest.TestCase):
    def test_delete_alias_subtree_presets_reload_and_isolation(self):
        from fastapi.testclient import TestClient
        from app.auth import current_user
        from app.main import app
        from app.personalization import save, records
        users = ['skilldelete' + uuid.uuid4().hex[:12] for _ in range(2)]
        selected = users[0]
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'BOB_WORKSPACE': directory}):
            root = Path(directory)
            builtin = root / '.bob/skills/data-buddy/SKILL.md'
            builtin.parent.mkdir(parents=True)
            builtin.write_text('---\nname: data-analyst\ndescription: Sample\n---\nFixture instructions\n')
            async def authenticated(request=None):
                config.select_root(root / 'users' / selected)
                return {'username': selected, 'is_admin': False}
            prior = app.dependency_overrides.get(current_user)
            app.dependency_overrides[current_user] = authenticated
            from app.access_boundary import AccessBoundaryMiddleware
            boundary_init = AccessBoundaryMiddleware.__init__
            def authenticated_boundary(boundary, downstream):
                boundary_init(boundary, downstream, authenticate=authenticated)
            boundary_patch = patch.object(AccessBoundaryMiddleware, '__init__', authenticated_boundary)
            boundary_patch.start()
            app.middleware_stack = None
            try:
                client = TestClient(app)
                self.assertEqual(client.get('/skills/data-analyst').status_code, 200)
                support = root / 'users' / selected / '.bob/skills/data-buddy/scripts/helper.py'
                storage.write_user_file(support, b'# fixture')
                for user in users:
                    save(user, 'presets', 'fixture', {'name': 'Sample', 'skill_name': 'data-analyst'}, create=True)
                from app.workflows import ensure_schema as ensure_workflows
                ensure_workflows()
                # Legacy aliases and scheduled workflows must lose the deleted
                # selection without erasing their independently authored content.
                with job_queue._connect() as db:
                    for user in users:
                        db.execute("""INSERT INTO bob_workflows(id,username,spec,next_run)
                                      VALUES (%s,%s,%s::jsonb,now())""",
                                   (str(uuid.uuid4()), user, '{"name":"Fixture","prompt":"Keep my prompt","skill_name":"data-analyst"}'))
                    db.execute("INSERT INTO bob_personalization(username,kind,id,record) VALUES (%s,'presets','legacy',%s::jsonb)",
                               (users[0], '{"name":"Legacy","skill_name":"data-analyst"}'))
                with job_queue._connect() as db:
                    storage._upsert(db, users[0], 'home:fixture', '.bob/skills/data-buddy/cache.txt', b'cached fixture')
                    storage._upsert(db, users[0], 'home:fixture', '.bob/other/settings.txt', b'keep')
                pending = str(uuid.uuid4())
                with job_queue._connect() as db:
                    db.execute("INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status) VALUES (%s,%s,'legacy',%s,'{}','running')", (pending,users[0],users[0]+':session:legacy'))
                self.assertEqual(client.delete('/skills/data-analyst').status_code, 409)
                self.assertEqual(client.get('/skills/data-analyst').status_code, 200)
                with job_queue._connect() as db:
                    db.execute('DELETE FROM bob_jobs WHERE id=%s', (pending,))
                self.assertEqual(client.delete('/skills/data-analyst').status_code, 200)
                self.assertEqual(TestClient(app).get('/skills').json(), [])
                self.assertEqual(client.get('/skills/data-analyst').status_code, 404)
                self.assertEqual(client.delete('/skills/data-analyst').status_code, 404)
                self.assertEqual(client.delete('/skills/invalid_name').status_code, 422)
                self.assertTrue(all(item['skill_name'] is None for item in records(users[0], 'presets')))
                with job_queue._connect() as db:
                    own = db.execute('SELECT * FROM bob_workflows WHERE username=%s', (users[0],)).fetchone()
                    other = db.execute('SELECT * FROM bob_workflows WHERE username=%s', (users[1],)).fetchone()
                self.assertIsNone(own['spec']['skill_name'])
                self.assertFalse(own['enabled'])
                self.assertIsNone(own['next_run'])
                self.assertEqual(own['spec']['prompt'], 'Keep my prompt')
                self.assertEqual(other['spec']['skill_name'], 'data-analyst')
                self.assertTrue(other['enabled'])
                from fastapi import HTTPException
                with self.assertRaises(HTTPException) as rejected:
                    save(users[0], 'presets', 'fixture', {'name':'Sample', 'skill_name':'data-analyst'})
                self.assertEqual(rejected.exception.status_code, 422)
                self.assertEqual(records(users[1], 'presets')[0]['skill_name'], 'data-buddy')
                self.assertEqual(storage.list_files(users[0], 'user', internal=True), [])
                self.assertIsNone(storage.get_file(users[0], 'home:fixture', '.bob/skills/data-buddy/cache.txt', internal=True))
                self.assertEqual(storage.get_file(users[0], 'home:fixture', '.bob/other/settings.txt', internal=True)['content'], b'keep')
                with job_queue._connect() as db:
                    storage._upsert(db, users[0], 'home:fixture', '.bob/skills/data-buddy/cache.txt', b'stale')
                self.assertIsNone(storage.get_file(users[0], 'home:fixture', '.bob/skills/data-buddy/cache.txt', internal=True))
                # Default seed and stale worker output must not resurrect it.
                storage.seed_user(users[0])
                storage.write_user_file(support, b'# stale worker output')
                restored = root / 'restored'
                storage.restore_tree(users[0], 'user', restored)
                self.assertFalse((restored / '.bob/skills/data-buddy').exists())
                selected = users[1]
                self.assertEqual(client.get('/skills/data-analyst').status_code, 200)
                self.assertTrue(builtin.exists())
                selected = users[0]
                alias = client.post('/skills', json={'name':'data-analyst','description':'Custom','instructions':'New fixture'})
                self.assertEqual(alias.status_code, 201, alias.text)
                save(users[0], 'presets', 'fixture', {'name':'Sample','skill_name':'data-analyst'})
                self.assertEqual([s['name'] for s in client.get('/skills').json()], ['data-buddy'])
                self.assertEqual(client.delete('/skills/data-analyst').status_code, 200)
                # A deliberately created custom skill with the old folder is allowed.
                selected = users[0]
                response = client.post('/skills', json={'name':'analysis','description':'Custom','instructions':'New fixture'})
                self.assertEqual(response.status_code, 201, response.text)
                self.assertEqual(client.delete('/skills/analysis').status_code, 200)
                self.assertEqual(client.get('/skills').json(), [])
            finally:
                boundary_patch.stop()
                app.middleware_stack = None
                if prior is None: app.dependency_overrides.pop(current_user, None)
                else: app.dependency_overrides[current_user] = prior
                config._selected_root.set(None)
                with job_queue._connect() as db:
                    db.execute('DELETE FROM bob_jobs WHERE username=ANY(%s)', (users,))
                    for table in ('bob_storage_files', 'bob_deleted_skills', 'bob_storage_users', 'bob_personalization', 'bob_skill_aliases', 'bob_workflows'):
                        db.execute(f'DELETE FROM {table} WHERE username=ANY(%s)', (users,))

    def test_catalog_skips_descriptor_deleted_after_scan(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict('os.environ', {'BOB_WORKSPACE': directory}), \
                patch.object(config, '_root', return_value=Path(directory) / 'users/alice'), \
                patch.object(storage, 'deleted_skill_folders', return_value=set()), \
                patch.object(storage, 'list_files', return_value=[{'path':'.bob/skills/sample/SKILL.md'}]), \
                patch.object(storage, 'read_user_file', return_value=None), \
                patch.object(storage, 'migrate_skill_names'):
            self.assertEqual(config.list_skills(), [])

    def test_local_custom_directory_removed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(config, '_root', return_value=Path(directory)):
            config.create_skill('sample', 'Example', 'Fixture')
            folder = Path(directory) / '.bob/skills/sample-buddy'
            (folder / 'asset.txt').write_text('Fixture')
            config.delete_skill('sample')
            self.assertFalse(folder.exists())


if __name__ == '__main__': unittest.main()
