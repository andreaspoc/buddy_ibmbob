"""Hermetic unit tests for postgres_storage, community chat, and decisions flow designer.
Tests cover advisory locks, file streaming/restoration, room membership validation,
typing notifications, away states, rule extraction, routing flows, and cycle detection.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
for plugin_path in (ROOT, *(ROOT / 'plugins').glob('*')):
    if plugin_path.is_dir() and str(plugin_path) not in sys.path:
        sys.path.insert(0, str(plugin_path))

from fastapi import HTTPException
from fastapi.datastructures import Headers

from app import postgres_storage as storage
from buddy_people import community
from buddy_people import community_away
from buddy_people import community_typing
from app.decisions_buddy import flow_designer
from app.decisions_buddy import safe_expression
from app.decisions_buddy import analysis


class PostgresStorageDeepTests(unittest.TestCase):
    """Deep unit tests for app/postgres_storage.py."""

    def setUp(self):
        self.username = 'test_user'

    def test_advisory_locks_and_mutation_constraints(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.job_queue._connect', mock_conn), patch.object(storage, 'ensure_schema'):
            # Basic _lock call
            storage._lock(db, 'alice', 'session:1')
            db.execute.assert_called_with('SELECT pg_advisory_xact_lock(hashtext(%s))', ('storage:alice:session:1',))

            # Mutation with user_lock=True
            db.execute.return_value.fetchone.return_value = None
            with storage.mutation('alice', 'session:1', user_lock=True) as conn:
                self.assertIs(conn, db)
            # Verify user lock acquired
            self.assertTrue(any(c.args == ('SELECT pg_advisory_xact_lock(hashtext(%s))', ('storage:alice:user',))
                                for c in db.execute.call_args_list))

            # Mutation fails if conversation is being deleted
            def exec_deleted(sql, *args):
                cur = MagicMock()
                if 'FROM bob_deleted_conversations' in sql:
                    cur.fetchone.return_value = (1,)
                else:
                    cur.fetchone.return_value = None
                return cur
            db.execute.side_effect = exec_deleted
            with self.assertRaisesRegex(ValueError, 'Conversation is being deleted'):
                with storage.mutation('alice', 'session:del', session_id='del'):
                    pass

            # Mutation fails if project does not exist
            def exec_proj_missing(sql, *args):
                cur = MagicMock()
                if 'FROM projects' in sql:
                    cur.fetchone.return_value = None
                else:
                    cur.fetchone.return_value = None
                return cur
            db.execute.side_effect = exec_proj_missing
            with self.assertRaises(FileNotFoundError):
                with storage.mutation('alice', 'project:nonexistent'):
                    pass

            # Mutation fails if job is actively running or queued
            def exec_job_active(sql, *args):
                cur = MagicMock()
                if 'FROM bob_jobs' in sql:
                    cur.fetchone.return_value = (1,)
                else:
                    cur.fetchone.return_value = None
                return cur
            db.execute.side_effect = exec_job_active
            with self.assertRaisesRegex(ValueError, 'Buddy is active'):
                with storage.mutation('alice', 'session:active'):
                    pass

    def test_cleanup_abandoned_workspaces(self):
        with tempfile.TemporaryDirectory() as td:
            with patch('tempfile.gettempdir', return_value=td):
                job_dir_dead = Path(td) / 'bob-job-dead'
                job_dir_dead.mkdir()
                (job_dir_dead / '.bob-storage-process').write_text('999999999')

                job_dir_live = Path(td) / 'bob-job-live'
                job_dir_live.mkdir()
                (job_dir_live / '.bob-storage-process').write_text(str(os.getpid()))

                job_dir_invalid = Path(td) / 'bob-job-invalid'
                job_dir_invalid.mkdir()
                (job_dir_invalid / '.bob-storage-process').write_text('-1')

                with patch('os.kill') as mock_kill:
                    def kill_effect(pid, sig):
                        if pid == 999999999:
                            raise ProcessLookupError()
                        return None
                    mock_kill.side_effect = kill_effect

                    storage.cleanup_abandoned_workspaces()
                    self.assertFalse(job_dir_dead.exists())
                    self.assertTrue(job_dir_live.exists())
                    self.assertTrue(job_dir_invalid.exists())

    def test_restore_tree_concurrency_and_reserved_skipping(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db = MagicMock()
            cursor = MagicMock()

            # Batch 1: reserved file + regular file
            # Batch 2: empty
            row_reserved = {
                'path': '.bob/settings.json', 'content': b'{"k":"v"}', 'mode': 0o644,
                'modified': 1000, 'sha256': hashlib.sha256(b'{"k":"v"}').hexdigest(),
                'object_key': None, 'object_bucket': None, 'size': 9
            }
            row_file = {
                'path': 'docs/readme.txt', 'content': b'hello world', 'mode': 0o644,
                'modified': 2000, 'sha256': hashlib.sha256(b'hello world').hexdigest(),
                'object_key': None, 'object_bucket': None, 'size': 11
            }

            cursor.fetchmany.side_effect = [[row_reserved, row_file], []]
            db.cursor.return_value.__enter__.return_value = cursor

            @contextmanager
            def mock_conn():
                yield db

            with patch('app.job_queue._connect', mock_conn), patch.object(storage, 'ensure_schema'):
                storage.restore_tree('alice', 'session:s1', root)

            # In session: scope, .bob/settings.json must be skipped
            self.assertFalse((root / '.bob' / 'settings.json').exists())
            self.assertTrue((root / 'docs' / 'readme.txt').exists())
            self.assertEqual((root / 'docs' / 'readme.txt').read_bytes(), b'hello world')

    def test_save_tree_validations_and_exclusions(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db = MagicMock()

            # 1. Symlink directory raises ValueError
            sub_dir = root / 'subdir'
            sub_dir.mkdir()
            symlink_dir = root / 'symdir'
            symlink_dir.symlink_to(sub_dir)

            with self.assertRaisesRegex(ValueError, 'symbolic links cannot be persisted'):
                storage.save_tree('alice', 'session:s1', root, db=db)
            symlink_dir.unlink()

            # 2. Symlink file (not .bob) raises ValueError
            regular = root / 'file.txt'
            regular.write_text('content')
            link_file = root / 'file_link.txt'
            link_file.symlink_to(regular)
            with self.assertRaisesRegex(ValueError, 'symbolic links cannot be persisted'):
                storage.save_tree('alice', 'session:s1', root, db=db)
            link_file.unlink()

            # 3. Size limit > 200MB raises ValueError
            import stat
            with patch.object(Path, 'stat') as mock_stat:
                stat_obj = MagicMock()
                stat_obj.st_size = storage.MAX_FILE_BYTES + 1024
                stat_obj.st_mode = stat.S_IFREG | 0o644
                stat_obj.st_mtime_ns = 12345
                mock_stat.return_value = stat_obj

                with self.assertRaisesRegex(ValueError, 'exceeds 200 MB'):
                    storage.save_tree('alice', 'session:s1', root, db=db)

            # 4. Successful save_tree with merge=False deletes unlisted files
            regular.write_text('test data')
            with patch.object(storage, '_upsert') as mock_upsert:
                count = storage.save_tree('alice', 'session:s1', root, db=db, merge=False)
                self.assertEqual(count, 1)
                mock_upsert.assert_called_once()
                # Verify deletion query preserves .bob/artifacts/%
                self.assertTrue(any('path NOT LIKE' in c.args[0] and '.bob/artifacts/%' in c.args[1]
                                    for c in db.execute.call_args_list))

            # 5. Successful save_tree with merge=True does not delete unlisted files
            db.execute.reset_mock()
            with patch.object(storage, '_upsert'):
                count = storage.save_tree('alice', 'session:s1', root, db=db, merge=True)
                self.assertEqual(count, 1)
                self.assertFalse(any('DELETE FROM bob_storage_files' in c.args[0]
                                     for c in db.execute.call_args_list))

    def test_job_workspace_and_persist_job(self):
        with tempfile.TemporaryDirectory() as td:
            user_dir = Path(td) / 'user'
            user_dir.mkdir()
            (user_dir / '.bob').mkdir()
            (user_dir / '.home' / '.bob').mkdir(parents=True)
            workspace_dir = Path(td) / 'workspace'
            workspace_dir.mkdir()

            with patch('app.sessions.user_root', return_value=user_dir), \
                 patch('app.sessions.workspace_for', return_value=workspace_dir), \
                 patch('app.sessions.storage_scope', return_value='session:s1'), \
                 patch.object(storage, 'restore_tree'), \
                 patch.object(storage, 'list_files', return_value=[]), \
                 patch.object(storage, 'partition_home'), \
                 patch.object(storage, 'migrate_skill_names'), \
                 patch('app.branding.refresh_identity_settings'):

                with storage.job_workspace('alice', 's1') as (u, w):
                    self.assertEqual(u, user_dir)
                    self.assertEqual(w, workspace_dir)
                    self.assertIsNotNone(storage.runtime_root())

        # Persist job: failure if worker lost lease
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        job = {'id': 'j1', 'worker_token': 'token1', 'username': 'alice', 'workspace_id': 's1'}
        with patch('app.job_queue._connect', mock_conn), patch('app.sessions.storage_scope', return_value='session:s1'):
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaisesRegex(RuntimeError, 'Worker lost its lease'):
                storage.persist_job(job, user_dir, workspace_dir)

            # Persist job success
            db.execute.return_value.fetchone.return_value = (1,)
            with patch.object(storage, 'save_tree'), \
                 patch('app.artifacts.capture_generated_revisions'):
                storage.persist_job(job, user_dir, workspace_dir)
                self.assertTrue(db.execute.called)

    def test_seed_user_and_skill_migrations(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # 1. seed_user skips if user already exists
        with patch('app.job_queue._connect', mock_conn), patch.object(storage, 'ensure_schema'):
            db.execute.return_value.fetchone.return_value = (1,)
            storage.seed_user('alice')
            # Does not proceed to migrate_skill_names
            self.assertEqual(db.execute.call_count, 1)

        # 2. seed_user seeds files if user does not exist
        with patch('app.job_queue._connect', mock_conn), \
             patch.object(storage, 'ensure_schema'), \
             patch.object(storage, 'migrate_skill_names'), \
             patch('app.sessions._root') as mock_root, \
             patch.object(storage, '_upsert') as mock_upsert:

            with tempfile.TemporaryDirectory() as td:
                root_path = Path(td)
                bob_dir = root_path / '.bob'
                bob_dir.mkdir()
                (bob_dir / 'default.json').write_text('{}')
                mock_root.return_value = root_path

                # First call: user not present, lock, user not present, row not in files
                db.execute.return_value.fetchone.side_effect = [None, None, None]
                storage.seed_user('alice')
                mock_upsert.assert_called_once()
                self.assertTrue(any('INSERT INTO bob_storage_users' in c.args[0]
                                    for c in db.execute.call_args_list))

        # 3. resolve_skill_alias
        db.execute.side_effect = None
        db.execute.return_value = MagicMock()
        db.execute.return_value.fetchone.side_effect = None
        with patch('app.job_queue._connect', mock_conn), patch.object(storage, 'ensure_schema'):
            db.execute.return_value.fetchone.return_value = {'name': 'canonical-skill'}
            self.assertEqual(storage.resolve_skill_alias('alice', 'legacy-alias'), 'canonical-skill')
            db.execute.return_value.fetchone.return_value = None
            self.assertEqual(storage.resolve_skill_alias('alice', 'unaliased'), 'unaliased')

    def test_delete_skill_tree_and_partition_home(self):
        # 1. delete_skill_tree raises SkillDeletionBusy if jobs active
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.job_queue._connect', mock_conn), \
             patch.object(storage, 'ensure_schema'), \
             patch('app.personalization.ensure_schema'), \
             patch.object(storage, 'user_file_identity', return_value=('alice', '.bob/skills/myskill/SKILL.md')):

            db.execute.return_value.fetchone.return_value = (1,)
            with self.assertRaises(storage.SkillDeletionBusy):
                storage.delete_skill_tree(Path('/path/to/myskill'), 'myskill')

            # Normal deletion
            def exec_del_skill(sql, *args):
                cur = MagicMock()
                if 'to_regclass' in sql:
                    cur.fetchone.return_value = {'name': None}
                elif 'SELECT 1 FROM bob_jobs' in sql:
                    cur.fetchone.return_value = None
                elif 'SELECT alias FROM bob_skill_aliases' in sql:
                    cur.fetchall.return_value = []
                else:
                    cur.fetchone.return_value = None
                    cur.fetchall.return_value = []
                return cur
            db.execute.side_effect = exec_del_skill
            with tempfile.TemporaryDirectory() as td:
                skill_dir = Path(td) / 'myskill'
                skill_dir.mkdir()
                storage.delete_skill_tree(skill_dir, 'myskill')
                self.assertFalse(skill_dir.exists())

        # 2. partition_home sqlite3 tasks pruning
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            db_dir = home / '.bob' / 'db'
            db_dir.mkdir(parents=True)
            db_file = db_dir / 'bob.db'
            conn = sqlite3.connect(db_file)
            conn.execute('CREATE TABLE tasks (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, first_message TEXT)')
            conn.execute("INSERT INTO tasks VALUES ('t1', '/sessions/s1', NULL, 'prompt1')")
            conn.execute("INSERT INTO tasks VALUES ('t2', '/sessions/s2', NULL, 'prompt2')")
            conn.commit()
            conn.close()

            with patch('app.sessions.read_history', return_value=[]), \
                 patch('app.job_queue.session_done_task_ids', return_value=set()), \
                 patch('app.job_queue.session_unique_bob_prompts', return_value=[]), \
                 patch('app.conversation_delete._delete_bob_tasks') as mock_del_tasks:

                storage.partition_home('alice', 's1', home)
                mock_del_tasks.assert_called_once()
                # t2 should be in others set passed to _delete_bob_tasks
                self.assertIn('t2', mock_del_tasks.call_args.args[1])


class CommunityPresenceAndMessagingTests(unittest.IsolatedAsyncioTestCase):
    """Deep unit tests for plugins/people/buddy_people/community.py and related modules."""

    def setUp(self):
        self.user = {'username': 'alice'}

    def test_room_create_validation(self):
        # Channel without name
        with self.assertRaisesRegex(ValueError, 'Enter a channel name'):
            community.RoomCreate(kind='channel', name='   ')

        # Direct without peer
        with self.assertRaisesRegex(ValueError, 'Select a member'):
            community.RoomCreate(kind='direct', peer=None)

        # Direct with extra members
        with self.assertRaisesRegex(ValueError, 'Select one peer'):
            community.RoomCreate(kind='direct', peer='bob', members=['charlie'])

        # Open channel with invited members
        with self.assertRaisesRegex(ValueError, 'Open channels cannot specify invited members'):
            community.RoomCreate(kind='channel', name='General', visibility='open', members=['charlie'])

        # Valid open channel
        r_chan = community.RoomCreate(kind='channel', name='General', visibility='open')
        self.assertEqual(r_chan.name, 'General')

        # Valid private channel
        r_priv = community.RoomCreate(kind='channel', name='Secret', visibility='private', members=['bob'])
        self.assertEqual(r_priv.visibility, 'private')

    def test_create_room_endpoints_and_membership(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.job_queue._connect', mock_conn), patch.object(community, 'ensure_schema'):
            # Direct chat with self -> 422
            with self.assertRaises(HTTPException) as exc:
                community.create_room(community.RoomCreate(kind='direct', peer='alice'), user=self.user)
            self.assertEqual(exc.exception.status_code, 422)

            # Direct chat with unregistered member -> 422
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(HTTPException) as exc:
                community.create_room(community.RoomCreate(kind='direct', peer='ghost'), user=self.user)
            self.assertEqual(exc.exception.status_code, 422)

            # Private channel with no valid other members -> 422
            with self.assertRaises(HTTPException) as exc:
                community.create_room(community.RoomCreate(kind='channel', name='Team', visibility='private', members=['alice']), user=self.user)
            self.assertEqual(exc.exception.status_code, 422)

            # Private channel with unregistered member -> 422
            db.execute.return_value.fetchall.return_value = []
            with self.assertRaises(HTTPException) as exc:
                community.create_room(community.RoomCreate(kind='channel', name='Team', visibility='private', members=['ghost']), user=self.user)
            self.assertEqual(exc.exception.status_code, 422)

            # Successful creation of channel
            def exec_create(sql, *args):
                cur = MagicMock()
                if 'INSERT INTO people_chat.bob_chat_rooms' in sql:
                    cur.fetchone.return_value = {'id': 42}
                return cur
            db.execute.side_effect = exec_create
            with patch.object(community, 'changed') as mock_changed:
                res = community.create_room(community.RoomCreate(kind='channel', name='General', visibility='open'), user=self.user)
                self.assertEqual(res['id'], 42)
                mock_changed.assert_called_once()

    def test_subscribe_and_unsubscribe(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.job_queue._connect', mock_conn), patch.object(community, 'ensure_schema'), patch.object(community, 'changed'):
            # Subscribe to non-existent or private channel -> 404
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(HTTPException) as exc:
                community.subscribe(99, user=self.user)
            self.assertEqual(exc.exception.status_code, 404)

            # Successful subscribe
            db.execute.return_value.fetchone.return_value = (1,)
            res = community.subscribe(10, user=self.user)
            self.assertTrue(res['subscribed'])

            # Unsubscribe from direct conversation -> 422
            with patch.object(community, 'member'):
                db.execute.return_value.fetchone.return_value = None  # Not a channel
                with self.assertRaises(HTTPException) as exc:
                    community.unsubscribe(10, user=self.user)
                self.assertEqual(exc.exception.status_code, 422)

                # Successful unsubscribe from channel
                db.execute.return_value.fetchone.return_value = (1,)
                res = community.unsubscribe(10, user=self.user)
                self.assertFalse(res['subscribed'])

    def test_read_acknowledgements_and_mark_read(self):
        # Model validations
        with self.assertRaisesRegex(ValueError, 'Select visible messages'):
            community.ReadAcknowledgement(message_id=None, message_ids=None)

        with self.assertRaisesRegex(ValueError, 'Invalid message ID'):
            community.ReadAcknowledgement(message_ids=[0, -1])

        ack_single = community.ReadAcknowledgement(message_id=5)
        self.assertEqual(ack_single.message_id, 5)

        ack_multi = community.ReadAcknowledgement(message_ids=[5, 6])
        self.assertEqual(ack_multi.message_ids, [5, 6])

        # mark_read
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.job_queue._connect', mock_conn), patch.object(community, 'ensure_schema'), patch.object(community, 'changed'):
            with patch.object(community, 'member', return_value={'last_read': 2, 'last_seen': 2}):
                # Message not found -> 404
                db.execute.return_value.fetchall.return_value = []
                with self.assertRaises(HTTPException) as exc:
                    community.mark_read(1, ack_single, user=self.user)
                self.assertEqual(exc.exception.status_code, 404)

                # Success mark_read
                db.execute.return_value.fetchall.side_effect = [
                    [{'id': 5}],  # Existing messages check
                    [{'message_id': 5}]  # Inserted seen
                ]
                res = community.mark_read(1, ack_single, user=self.user)
                self.assertEqual(res['last_read'], 5)
                self.assertEqual(res['last_seen'], 5)

    def test_send_message_validations_and_attachments(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.job_queue._connect', mock_conn), patch.object(community, 'ensure_schema'), patch.object(community, 'member'):
            # Empty body and no file -> 422
            with self.assertRaises(HTTPException) as exc:
                community.send(1, body='   ', note_id=None, file=None, user=self.user, parent_id=None, mention_ids='[]')
            self.assertEqual(exc.exception.status_code, 422)

            # File > 20 MB -> 413
            mock_file = MagicMock()
            mock_file.filename = 'huge.bin'
            mock_file.file.read.return_value = b'x' * (community.MAX_FILE + 2)
            with self.assertRaises(HTTPException) as exc:
                community.send(1, body='Here is file', note_id=None, file=mock_file, user=self.user, parent_id=None, mention_ids='[]')
            self.assertEqual(exc.exception.status_code, 413)

            # Mention non-members -> 422
            db.execute.return_value.fetchall.return_value = []
            with self.assertRaises(HTTPException) as exc:
                community.send(1, body='Hello @ghost', note_id=None, file=None, user=self.user, parent_id=None, mention_ids='["ghost"]')
            self.assertEqual(exc.exception.status_code, 422)

            # Successful send with valid snapshot
            def exec_send(sql, *args):
                cur = MagicMock()
                if 'INSERT INTO people_chat.bob_chat_messages' in sql:
                    cur.fetchone.return_value = {'id': 100}
                return cur
            db.execute.side_effect = exec_send

            with patch.object(community, 'message_snapshot', return_value=[{'id': 100, 'body': 'Hello!'}]), \
                 patch('buddy_people.community_away.enqueue'), \
                 patch.object(community, 'changed'):
                msg = community.send(1, body='Hello!', note_id=None, file=None, user=self.user, parent_id=None, mention_ids='[]')
                self.assertEqual(msg['id'], 100)
                self.assertEqual(msg['body'], 'Hello!')

    def test_community_away_settings_and_status(self):
        # Settings validation
        now = datetime.now(timezone.utc)
        # Missing timezone
        with self.assertRaisesRegex(ValueError, 'date with a timezone'):
            community_away.Settings(enabled=True, instructions='Away', starts_at=datetime.now())

        # Enabled without instructions
        with self.assertRaisesRegex(ValueError, 'Add instructions'):
            community_away.Settings(enabled=True, instructions='', ends_at=now + timedelta(days=1))

        # End time in the past
        with self.assertRaisesRegex(ValueError, 'Choose a future end time'):
            community_away.Settings(enabled=True, instructions='Away', ends_at=now - timedelta(hours=1))

        # Duration > 7 days
        with self.assertRaisesRegex(ValueError, 'at most seven days'):
            community_away.Settings(enabled=True, instructions='Away', ends_at=now + timedelta(days=10))

        # Valid settings
        valid_settings = community_away.Settings(enabled=True, instructions='Out of office', ends_at=now + timedelta(days=2))
        self.assertTrue(valid_settings.enabled)

        # Status and put_settings
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.job_queue._connect', mock_conn), patch('buddy_people.community.ensure_schema'):
            with patch.object(community_away, 'ready', return_value=False):
                # When not ready, enabling raises 503
                router = MagicMock()
                current_user_dep = MagicMock()
                same_origin_dep = MagicMock()
                handlers = {}
                def mock_put(path, **kwargs):
                    def decorator(f):
                        handlers['put'] = f
                        return f
                    return decorator
                router.put = mock_put
                community_away.register(router, current_user_dep, same_origin_dep)

                with self.assertRaises(HTTPException) as exc:
                    handlers['put'](valid_settings, user=self.user)
                self.assertEqual(exc.exception.status_code, 503)

    async def test_websocket_socket_updates_and_typing(self):
        socket = MagicMock()
        socket.headers = Headers({'origin': 'http://localhost', 'host': 'localhost'})
        socket.query_params = {'messages': '1'}
        socket.accept = AsyncMock()
        socket.send_json = AsyncMock()
        socket.close = AsyncMock()

        # Mock current_user returning alice
        with patch.dict(os.environ, {'DATABASE_URL': 'postgres://test:5432/db'}), \
             patch('buddy_people.community.current_user', new=AsyncMock(return_value={'username': 'alice'})), \
             patch('buddy_people.community.ensure_schema'):

            # Mock AsyncConnection
            class MockEvent:
                def __init__(self, channel, payload):
                    self.channel = channel
                    self.payload = payload

            class MockAsyncConn:
                def __init__(self):
                    self.calls = 0

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    pass

                async def execute(self, sql, *args):
                    cur = MagicMock()
                    cur.fetchone = AsyncMock(return_value=(1,))
                    return cur

                async def notifies(self, timeout=25, stop_after=1):
                    self.calls += 1
                    if self.calls == 1:
                        yield MockEvent('bob_community_typing', json.dumps({'room_id': 1, 'username': 'bob', 'typing': True}))
                    else:
                        raise asyncio.CancelledError()

            with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://test:test@localhost/test'}), \
                 patch('psycopg.AsyncConnection.connect', new=AsyncMock(return_value=MockAsyncConn())), \
                 patch.object(community, 'current_user', new=AsyncMock(return_value={'username': 'alice'})):
                with self.assertRaises(asyncio.CancelledError):
                    await community.socket_updates(socket)

                socket.accept.assert_awaited_once()
                socket.send_json.assert_awaited()
                sent_signal = socket.send_json.call_args_list[0].args[0]
                self.assertEqual(sent_signal['username'], 'bob')
                self.assertTrue(sent_signal['typing'])


class DecisionsFlowDesignerDeepTests(unittest.TestCase):
    """Deep unit tests for app/decisions_buddy/flow_designer.py and graph validation."""

    def test_flow_designer_curated_presets(self):
        # 1. Churn retention preset
        res = flow_designer.generate_decision_flow("Help me design a retention flow with churn scoring and watsonx ML")
        self.assertIn("Retention", res["name"])
        self.assertIn("nodes", res["graph"])
        safe_expression.validate_graph(res["graph"])
        diags = analysis.analyze_graph(res["graph"])
        self.assertFalse(any(d["severity"] == "error" for d in diags))

        # 2. Fraud triage preset
        res = flow_designer.generate_decision_flow("Create real-time fraud triage and anomaly detection")
        self.assertIn("Fraud", res["name"])
        safe_expression.validate_graph(res["graph"])

        # 3. Loan underwriting preset
        res = flow_designer.generate_decision_flow("Loan underwriting decision flow")
        self.assertIn("Underwriting", res["name"])
        safe_expression.validate_graph(res["graph"])

        # 4. VIP routing preset
        res = flow_designer.generate_decision_flow("Customer tier VIP loyalty routing")
        self.assertIn("VIP", res["name"])
        safe_expression.validate_graph(res["graph"])

        # 5. E-Commerce pricing preset
        res = flow_designer.generate_decision_flow("Ecommerce cart order tax and pricing calculation")
        self.assertIn("Pricing", res["name"])
        safe_expression.validate_graph(res["graph"])

    def test_routing_decision_flow_generation(self):
        # Generates branching switch router topology
        prompt = "Switch routing policy: if customer.tier == 'VIP' then route to priority discount else standard"
        res = flow_designer.generate_decision_flow(prompt)
        graph = res["graph"]
        node_types = [n["type"] for n in graph["nodes"]]
        self.assertIn("switchNode", node_types)
        self.assertIn("decisionTableNode", node_types)
        self.assertIn("outputNode", node_types)

        # Graph passes DAG validation
        safe_expression.validate_graph(graph)

    def test_multistage_decision_flow_generation(self):
        prompt = "Multi-stage screening pipeline: Stage 1 evaluates eligibility, then Stage 2 assigns discount"
        res = flow_designer.generate_decision_flow(prompt)
        graph = res["graph"]
        node_names = [n["name"] for n in graph["nodes"]]
        self.assertTrue(any("Stage 1" in name for name in node_names))
        self.assertTrue(any("Stage 2" in name for name in node_names))
        safe_expression.validate_graph(graph)

    def test_calculation_and_watsonx_flow_generation(self):
        prompt = "Calculate cart total with formula and tax using watsonx ML predictive scoring if cart >= 100 gives 20%"
        res = flow_designer.generate_decision_flow(prompt)
        graph = res["graph"]
        node_types = [n["type"] for n in graph["nodes"]]
        self.assertIn("watsonxMlNode", node_types)
        self.assertIn("expressionNode", node_types)
        self.assertIn("decisionTableNode", node_types)
        safe_expression.validate_graph(graph)

    def test_rule_extraction_and_domains(self):
        # Test topup domain rule extraction
        prompt = "Topup flow: if topup is at least 50 then give 20% discount. If topup is at least 20 then give 10% discount."
        res = flow_designer.generate_decision_flow(prompt)
        self.assertIn("Topup", res["name"])
        table_node = next(n for n in res["graph"]["nodes"] if n["type"] == "decisionTableNode")
        rules = table_node["content"]["rules"]
        self.assertGreaterEqual(len(rules), 3)  # 2 explicit + 1 fallback
        self.assertEqual(rules[0]["in_1"], ">= 50")
        self.assertEqual(rules[1]["in_1"], ">= 20")
        self.assertEqual(rules[2]["in_1"], "-")  # Fallback

        # Test creditScore domain
        prompt_credit = "Credit assessment: if score is at least 700 then approve"
        res_credit = flow_designer.generate_decision_flow(prompt_credit)
        self.assertIn("Credit", res_credit["name"])

        # Test customer age domain
        prompt_age = "If age is at least 18 then approved"
        res_age = flow_designer.generate_decision_flow(prompt_age)
        self.assertIn("Age", res_age["name"])

    def test_graph_validation_and_cyclic_loop_detection(self):
        # Generate valid flow
        res = flow_designer.generate_decision_flow("If amount >= 100 then gives 15% discount")
        graph = res["graph"]
        safe_expression.validate_graph(graph)

        # Artificially inject an edge cycle: node_output -> node_input
        cycle_graph = {
            "nodes": graph["nodes"],
            "edges": graph["edges"] + [
                {"id": "e_cycle", "sourceId": "node_output", "targetId": "node_input"}
            ]
        }
        with self.assertRaisesRegex(ValueError, "Decision graphs cannot contain cycles"):
            safe_expression.validate_graph(cycle_graph)

        # Orphan node check with analysis.analyze_graph
        orphan_graph = {
            "nodes": graph["nodes"] + [
                {"id": "node_orphan", "name": "Orphan Node", "type": "expressionNode", "position": {"x": 500, "y": 500}, "content": {}}
            ],
            "edges": graph["edges"]
        }
        diags = analysis.analyze_graph(orphan_graph)
        codes = [d["code"] for d in diags]
        self.assertIn("ORPHAN_NODE_NO_INPUT", codes)
        self.assertIn("ORPHAN_NODE_NO_OUTPUT", codes)


if __name__ == '__main__':
    unittest.main()
