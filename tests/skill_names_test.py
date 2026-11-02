"""Buddy naming fixtures never alter real accounts."""
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from app.skill_names import canonical_skill_name, migration_plan, rename_descriptor, descriptor_name
from app import postgres_storage as storage, workspace_config as config, job_queue


def document(name, body='User edited instructions'):
    return f'---\nname: {name}\ndescription: Sample\nallowed-tools: [Read]\n---\n{body}\n'.encode()


class SkillNamesTests(unittest.TestCase):
    def test_collisions_and_idempotence(self):
        descriptors = {'data-buddy': document('data-buddy', 'Custom Buddy'), 'data-analyst': document('data-analyst')}
        plan = migration_plan(descriptors)
        self.assertEqual(plan['data-buddy'][1], 'data-buddy')
        target = plan['data-analyst'][1]
        self.assertNotEqual(target, 'data-buddy')
        self.assertTrue(target.endswith('-buddy'))
        renamed = {new: rename_descriptor(descriptors[old], new) for old, (_, new) in plan.items()}
        self.assertEqual(set(renamed), {value[1] for value in migration_plan(renamed).values()})
        self.assertIn(b'User edited instructions', renamed[target])
        self.assertIn(b'allowed-tools', renamed[target])
        self.assertLessEqual(len(canonical_skill_name('x' * 64)), 64)
        self.assertEqual(canonical_skill_name('support-agent'), 'support-buddy')

    def test_durable_alias_files_presets_tombstones_and_recreation(self):
        from app.personalization import ensure_schema
        username = 'buddynames' + uuid.uuid4().hex[:12]
        storage.ensure_schema()
        ensure_schema()
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'BOB_WORKSPACE': directory}):
            root = Path(directory)
            user = root / 'users' / username
            config.select_root(user)
            try:
                storage.write_user_file(user / '.bob/skills/data-analyst/SKILL.md', document('data-analyst'))
                storage.write_user_file(user / '.bob/skills/data-analyst/scripts/helper.py', b'# support')
                storage.write_user_file(user / '.bob/skills/support-agent/SKILL.md', document('support-agent'))
                with job_queue._connect() as db:
                    db.execute('INSERT INTO bob_deleted_skills VALUES (%s,%s,%s)', (username,'sample-skill','sample-skill'))
                    db.execute('INSERT INTO bob_personalization VALUES (%s,%s,%s,%s::jsonb)', (username,'presets','sample','{"skill_name":"data-analyst"}'))
                storage.migrate_skill_names(username)
                storage.migrate_skill_names(username)
                self.assertEqual(config.get_skill('data-analyst')['name'], 'data-buddy')
                self.assertEqual(storage.read_user_file(user / '.bob/skills/data-buddy/scripts/helper.py'), b'# support')
                self.assertIsNone(storage.read_user_file(user / '.bob/skills/data-analyst/SKILL.md'))
                self.assertIn('sample-buddy', storage.deleted_skill_folders(username))
                with job_queue._connect() as db:
                    self.assertEqual(db.execute('SELECT record FROM bob_personalization WHERE username=%s', (username,)).fetchone()['record']['skill_name'], 'data-buddy')
                config.create_skill('sample-skill', 'Recreated', 'Recreated instructions')
                storage.migrate_skill_names(username)
                self.assertEqual(config.get_skill('sample-buddy')['instructions'], 'Recreated instructions')
                self.assertEqual({x['name'] for x in config.list_skills()}, {'data-buddy','support-buddy','sample-buddy'})
                config.delete_skill('data-analyst')
                storage.write_user_file(user / '.bob/skills/data-analyst/SKILL.md', document('data-analyst'))
                storage.write_user_file(user / '.bob/skills/data-analyst/scripts/helper.py', b'# stale worker')
                storage.migrate_skill_names(username)
                self.assertEqual({x['name'] for x in config.list_skills()}, {'support-buddy','sample-buddy'})
                self.assertIsNone(storage.read_user_file(user / '.bob/skills/data-analyst/scripts/helper.py'))
            finally:
                config._selected_root.set(None)
                with job_queue._connect() as db:
                    for table in ['bob_storage_files','bob_personalization','bob_deleted_skills','bob_skill_aliases']:
                        db.execute('DELETE FROM '+table+' WHERE username=%s', (username,))


if __name__ == '__main__':
    unittest.main()
