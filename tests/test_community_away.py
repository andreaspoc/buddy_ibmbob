"""Away reply safety and opt-in behavior."""
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import TestCase, IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch
from pydantic import ValidationError
from app import community_away as away
from app.agent_budget import BudgetExceeded, RunBudget


class SettingsTests(TestCase):
    def test_executable_lookup_ignores_environment_path(self):
        with patch.dict(os.environ, {'PATH': '/untrusted'}), \
             patch.object(away.shutil, 'which', return_value='/usr/local/bin/bob') as lookup:
            self.assertEqual(away._bob_executable(), '/usr/local/bin/bob')
        lookup.assert_called_once_with('bob', path=away.TRUSTED_EXECUTABLE_PATH)

    def test_default_off(self):
        self.assertFalse(away.Settings().enabled)

    def test_enabled_requires_instructions_and_expiry(self):
        for body in ({'enabled': True}, {'enabled': True, 'instructions': 'Away'},
                     {'enabled': True, 'instructions': 'Away', 'ends_at': datetime.now(timezone.utc)-timedelta(seconds=1)},
                     {'enabled': True, 'instructions': 'Away', 'ends_at': datetime.now(timezone.utc)+timedelta(days=8)}):
            with self.assertRaises(ValidationError):
                away.Settings(**body)

    def test_ambiguous_timezone_rejected(self):
        with self.assertRaises(ValidationError):
            away.Settings(starts_at=datetime.now())

    def test_period_accepted(self):
        self.assertTrue(away.Settings(enabled=True, instructions='Back tomorrow',
            ends_at=datetime.now(timezone.utc)+timedelta(hours=1)).enabled)

    def test_expired_disabled_revision_mismatch_never_eligible(self):
        for changes in ({'enabled': False}, {'revision': 2},
                        {'ends_at': datetime.now(timezone.utc)-timedelta(seconds=1)}):
            db = MagicMock()
            db.execute.return_value.fetchone.return_value = dict(enabled=True,revision=1,
                starts_at=None,ends_at=datetime.now(timezone.utc)+timedelta(hours=1), **{}) | changes
            self.assertIsNone(away.eligible(db, dict(recipient='alice', revision=1, room_id=4, trigger_id=5)))
            self.assertEqual(db.execute.call_count, 1)

    def test_enqueue_only_direct_enabled_other_member_transaction(self):
        db = MagicMock()
        away.enqueue(db, 1, 2, 'alice')
        sql,args = db.execute.call_args.args
        self.assertIn("r.kind='direct'", sql)
        self.assertIn('a.username<>%s AND a.enabled', sql)
        self.assertIn('a.ends_at>now()', sql)
        self.assertIn('ON CONFLICT DO NOTHING', sql)
        self.assertEqual(args, (2,1,1,'alice'))

    def test_manually_replied_suppresses(self):
        db = MagicMock()
        db.execute.return_value.fetchone.side_effect = [dict(enabled=True, revision=1,
            starts_at=None, ends_at=datetime.now(timezone.utc)+timedelta(hours=1)), None, {'ok': 1}, {'ok': 1}]
        self.assertIsNone(away.eligible(db, dict(recipient='alice',revision=1,room_id=4,trigger_id=5)))


class GenerationTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.budget = RunBudget('synthetic-owner')
        quota = patch('app.agent_budget.RunBudget.consume', new_callable=AsyncMock)
        self.consume = quota.start()
        self.addCleanup(quota.stop)
        sandbox = patch('app.agent_sandbox.sandbox_command', side_effect=lambda command, **kwargs: command)
        sandbox.start()
        self.addCleanup(sandbox.stop)
        executable = patch.object(away, '_bob_executable', return_value='/usr/local/bin/bob')
        executable.start()
        self.addCleanup(executable.stop)

    async def test_tool_free_generation_isolates_environment_and_workspace(self):
        async def spawn(*args, **kwargs):
            self.assertEqual(args[0], '/usr/local/bin/bob')
            self.assertEqual(kwargs['env']['PATH'], away.TRUSTED_EXECUTABLE_PATH)
            self.assertIn('--mode', args)
            self.assertIn('away-reply', args)
            workspace = Path(kwargs['cwd'])
            mode = json.loads((workspace/'.bob/custom_modes.yaml').read_text())['customModes'][0]
            self.assertEqual(mode['groups'], [])
            self.assertEqual(json.loads((workspace/'.bob/mcp.json').read_text()), {'mcpServers': {}})
            self.assertNotEqual(kwargs['env']['HOME'], '/private-user-home')
            for key in ('DATABASE_URL', 'BOB_KNOWLEDGE_SOCKET', 'BOB_MCP_SOCKET', 'AWS_SECRET_ACCESS_KEY'):
                self.assertNotIn(key, kwargs['env'])
            proc = MagicMock(returncode=0)
            proc.communicate = AsyncMock(return_value=(json.dumps({'status':'success','last_message':'Thanks, I am away until Monday.'}).encode(), b''))
            return proc
        with patch.object(away, 'ready', return_value=True), patch.dict(os.environ, {'BOB_API_KEY': 'test', 'DATABASE_URL': 'secret', 'HOME':'/private-user-home', 'PATH':'/untrusted'}), patch('app.community_away.asyncio.create_subprocess_exec', side_effect=spawn), patch('app.acp_bridge._stop_process_group', new=AsyncMock()):
            self.assertIn('Monday', await away.generate('Back Monday', 'Hello', [], budget=self.budget))
        self.consume.assert_awaited_once_with('inference')

    async def test_duplicate_reply_refused_after_two_attempts(self):
        proc = MagicMock(returncode=0)
        proc.communicate = AsyncMock(return_value=(b'{"status":"success","last_message":"I am away!"}', b''))
        with patch.object(away, 'ready', return_value=True), patch.dict(os.environ, {'BOB_API_KEY':'test'}), patch('app.community_away.asyncio.create_subprocess_exec', new=AsyncMock(return_value=proc)) as spawn, patch('app.acp_bridge._stop_process_group', new=AsyncMock()):
            with self.assertRaises(RuntimeError):
                await away.generate('Away', 'hello', ['i AM away.'], budget=self.budget)
            self.assertEqual(spawn.await_count, 2)
        self.assertEqual(self.consume.await_count, 2)

    async def test_shell_metacharacters_remain_prompt_data(self):
        payload = 'hello $(touch /tmp/never-run); `id`'
        proc = MagicMock(returncode=0)
        proc.communicate = AsyncMock(return_value=(b'{"status":"success","last_message":"Away"}', b''))
        with patch.object(away, 'ready', return_value=True), \
             patch('app.community_away.asyncio.create_subprocess_exec', new=AsyncMock(return_value=proc)) as spawn, \
             patch('app.acp_bridge._stop_process_group', new=AsyncMock()):
            await away.generate('Away', payload, [], budget=self.budget)
        args = spawn.call_args.args
        self.assertEqual(args[0], '/usr/local/bin/bob')
        self.assertIn(payload, args[-1])
        self.assertNotIn('/bin/sh', args)

    async def test_failed_generation_does_not_use_canned_reply(self):
        proc = MagicMock(returncode=1)
        proc.communicate = AsyncMock(return_value=(b'{"status":"error"}', b''))
        with patch.object(away, 'ready', return_value=True), patch.dict(os.environ, {'BOB_API_KEY':'test'}), patch('app.community_away.asyncio.create_subprocess_exec', new=AsyncMock(return_value=proc)), patch('app.acp_bridge._stop_process_group', new=AsyncMock()):
            with self.assertRaises(RuntimeError):
                await away.generate('Away', 'hello', [], budget=self.budget)

    async def test_missing_or_exhausted_quota_never_launches_runtime(self):
        with patch.object(away, 'ready', return_value=True), patch('app.community_away.asyncio.create_subprocess_exec', new_callable=AsyncMock) as spawn:
            with self.assertRaises(PermissionError):
                await away.generate('Away', 'hello', [])
            self.consume.side_effect = BudgetExceeded('Synthetic exhausted quota')
            with self.assertRaises(BudgetExceeded):
                await away.generate('Away', 'hello', [], budget=self.budget)
            spawn.assert_not_awaited()


@__import__('unittest').skipUnless(os.getenv('DATABASE_URL'), 'requires PostgreSQL')
class DatabaseTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app import community, job_queue
        import uuid
        community.ensure_schema()
        self.owner = 'away-test-' + uuid.uuid4().hex
        self.peer = self.owner + '-peer'
        with job_queue._connect() as db:
            self.room = db.execute("INSERT INTO people_chat.bob_chat_rooms(kind,name,creator,visibility) VALUES ('direct','test',%s,'private') RETURNING id", (self.owner,)).fetchone()['id']
            for name in (self.owner, self.peer):
                db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES (%s,%s)', (self.room,name))
            db.execute("INSERT INTO people_chat.bob_chat_away(username,enabled,instructions,ends_at) VALUES (%s,true,'Back Monday',now()+interval '1 hour')", (self.owner,))

    async def asyncTearDown(self):
        from app import job_queue
        with job_queue._connect() as db:
            db.execute('DELETE FROM people_chat.bob_chat_away_jobs WHERE room_id=%s', (self.room,))
            db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE id=%s', (self.room,))
            db.execute('DELETE FROM people_chat.bob_chat_away WHERE username=%s', (self.owner,))

    def trigger(self):
        from app import job_queue
        with job_queue._connect() as db:
            message = db.execute("INSERT INTO people_chat.bob_chat_messages(room_id,sender,body) VALUES (%s,%s,'hello') RETURNING id", (self.room,self.peer)).fetchone()['id']
            away.enqueue(db, self.room, message, self.peer)
            away.enqueue(db, self.room, message, self.peer)
            job = db.execute('SELECT * FROM people_chat.bob_chat_away_jobs WHERE trigger_id=%s', (message,)).fetchall()
            self.assertEqual(len(job), 1)
            return db.execute("UPDATE people_chat.bob_chat_away_jobs SET state='running',token='test',attempts=1,lease_until=now()+interval '4 minutes' WHERE id=%s RETURNING *", (job[0]['id'],)).fetchone()

    async def test_manual_reply_pauses_future_incoming_until_settings_resaved(self):
        from app import job_queue
        self.trigger()
        with job_queue._connect() as db:
            away.enqueue(db, self.room, 9999991, self.owner)
            away.enqueue(db, self.room, 9999992, self.peer)
            self.assertIsNone(db.execute('SELECT 1 FROM people_chat.bob_chat_away_jobs WHERE trigger_id=9999992').fetchone())
            db.execute('UPDATE people_chat.bob_chat_away SET revision=revision+1 WHERE username=%s', (self.owner,))
            away.enqueue(db, self.room, 9999993, self.peer)
            self.assertIsNotNone(db.execute('SELECT 1 FROM people_chat.bob_chat_away_jobs WHERE trigger_id=9999993').fetchone())

    async def test_publish_exactly_once_and_automated_no_loop(self):
        from app import job_queue
        job = self.trigger()
        with patch.object(away, 'generate', new=AsyncMock(return_value='I will review this when back Monday.')):
            await away.process(job)
            await away.process(job)
        with job_queue._connect() as db:
            self.assertEqual(db.execute('SELECT count(*) AS n FROM people_chat.bob_chat_messages WHERE room_id=%s AND automated', (self.room,)).fetchone()['n'], 1)
            self.assertEqual(db.execute('SELECT count(*) AS n FROM people_chat.bob_chat_away_jobs WHERE room_id=%s', (self.room,)).fetchone()['n'], 1)

    async def test_disable_during_generation_prevents_publication(self):
        from app import job_queue
        job = self.trigger()
        async def disable(*args, **kwargs):
            with job_queue._connect() as db:
                db.execute('UPDATE people_chat.bob_chat_away SET enabled=false,revision=revision+1 WHERE username=%s', (self.owner,))
            return 'This must never send.'
        with patch.object(away, 'generate', side_effect=disable):
            await away.process(job)
        with job_queue._connect() as db:
            self.assertEqual(db.execute('SELECT count(*) AS n FROM people_chat.bob_chat_messages WHERE room_id=%s AND automated', (self.room,)).fetchone()['n'], 0)

    async def test_manual_reply_during_generation_prevents_publication(self):
        from app import job_queue
        job = self.trigger()
        async def manual(*args, **kwargs):
            with job_queue._connect() as db:
                db.execute("INSERT INTO people_chat.bob_chat_messages(room_id,sender,body) VALUES (%s,%s,'I am here')", (self.room,self.owner))
            return 'This must never send.'
        with patch.object(away, 'generate', side_effect=manual):
            await away.process(job)
        with job_queue._connect() as db:
            self.assertEqual(db.execute('SELECT count(*) AS n FROM people_chat.bob_chat_messages WHERE room_id=%s AND automated', (self.room,)).fetchone()['n'], 0)


if __name__ == '__main__':
    import unittest
    unittest.main()
