"""Selected-context privacy, language instructions and non-repeating Bob replies."""
import json
import os
import uuid
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import APIRouter, HTTPException, Response
from app import community_bob as bob, community_away as away
from app.agent_budget import RunBudget


class GenerationTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_question_language_and_collaboration_role_isolated(self):
        async def spawn(*args, **kwargs):
            mode=json.loads((Path(kwargs['cwd'])/'.bob/custom_modes.yaml').read_text())['customModes'][0]
            self.assertEqual(mode['groups'], [])
            self.assertIn('language of incoming_message',mode['roleDefinition'])
            self.assertIn('even when owner_instructions',mode['roleDefinition'])
            self.assertIn('Do not adopt an away persona',mode['roleDefinition'])
            self.assertIn('incoming_message', args[-1])
            proc=MagicMock(returncode=0)
            proc.communicate=AsyncMock(return_value=(json.dumps({'status':'success','last_message':'Καλημέρα, πώς μπορώ να βοηθήσω;'},ensure_ascii=False).encode(),b''))
            return proc
        with patch.object(away,'ready',return_value=True),patch('app.community_away.asyncio.create_subprocess_exec',side_effect=spawn),patch('app.acp_bridge._stop_process_group',new=AsyncMock()):
            self.assertIn('Καλημέρα', await away.generate('Instructions in English','Καλημέρα',[],purpose='collaboration',budget=self.budget))

    async def test_duplicate_generation_rewrites_with_explicit_correction(self):
        prompts=[]
        async def spawn(*args,**kwargs):
            prompts.append(args[-1])
            text='Old reply' if len(prompts)==1 else 'New sentence with the same facts'
            proc=MagicMock(returncode=0)
            proc.communicate=AsyncMock(return_value=(json.dumps({'status':'success','last_message':text}).encode(),b''))
            return proc
        with patch.object(away,'ready',return_value=True),patch('app.community_away.asyncio.create_subprocess_exec',side_effect=spawn),patch('app.acp_bridge._stop_process_group',new=AsyncMock()):
            reply=await away.generate('Back Monday','When are you back?',['Old reply'],budget=self.budget)
        self.assertEqual(reply,'New sentence with the same facts')
        self.assertIn('Rejected exact repeat',prompts[1])
        self.assertIn('Old reply',prompts[1])


@unittest.skipUnless(os.getenv('DATABASE_URL'),'requires PostgreSQL')
class DatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app import community as c, job_queue
        c.ensure_schema()
        with job_queue._connect() as db: bob.schema(db)
        self.user='bob-selection-test-'+uuid.uuid4().hex
        self.router=APIRouter()
        bob.register(self.router, lambda: None, lambda: None)
        self.ask=next(r.endpoint for r in self.router.routes if r.path.endswith('/bob'))
        with job_queue._connect() as db:
            self.rooms=[]
            for _ in range(2):
                room=db.execute("INSERT INTO people_chat.bob_chat_rooms(kind,name,creator,visibility) VALUES ('channel','test',%s,'private') RETURNING id",(self.user,)).fetchone()['id']
                self.rooms.append(room)
                db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES (%s,%s)',(room,self.user))
            self.ids=[]
            for room,body in [(self.rooms[0],'SELECTED CONTEXT'),(self.rooms[0],'DO NOT INCLUDE PRIVATE HISTORY'),(self.rooms[1],'OTHER ROOM SECRET')]:
                self.ids.append(db.execute('INSERT INTO people_chat.bob_chat_messages(room_id,sender,body) VALUES (%s,%s,%s) RETURNING id',(room,self.user,body)).fetchone()['id'])

    async def asyncTearDown(self):
        from app import job_queue
        with job_queue._connect() as db:
            db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE id=ANY(%s)',(self.rooms,))

    async def call(self, ids=None, user=None):
        return await self.ask(self.rooms[0],bob.AskBob(prompt='Ποια είναι η σύνοψη;',message_ids=ids or [self.ids[0]]),Response(),user or {'username':self.user})

    async def test_only_explicit_selection_and_no_away_loop(self):
        from app import job_queue
        async def generate(instructions,incoming,previous,**kwargs):
            self.assertIn('SELECTED CONTEXT',instructions)
            self.assertNotIn('DO NOT INCLUDE',instructions)
            self.assertNotIn('OTHER ROOM',instructions)
            self.assertEqual(incoming,'Ποια είναι η σύνοψη;')
            self.assertEqual(previous,[])
            self.assertEqual(kwargs['purpose'],'collaboration')
            self.assertEqual(kwargs['budget'].username, self.user)
            self.assertEqual(kwargs['context_info']['conversation_kind'],'channel')
            return 'Η σύνοψη.'
        with patch.object(away,'generate',side_effect=generate):
            result=await self.call()
        with job_queue._connect() as db:
            row=db.execute('SELECT * FROM people_chat.bob_chat_messages WHERE id=%s',(result['id'],)).fetchone()
            self.assertTrue(row['automated'])
            self.assertEqual(row['shared']['kind'],'bob')
            self.assertTrue(db.execute('SELECT 1 FROM people_chat.bob_chat_dependencies WHERE source_id=%s AND derived_id=%s',(self.ids[0],result['id'])).fetchone())
            self.assertFalse(db.execute('SELECT 1 FROM people_chat.bob_chat_away_jobs WHERE trigger_id=%s',(result['id'],)).fetchone())

    async def test_crossroom_and_outsider_rejected_before_generation(self):
        with patch.object(away,'generate',new=AsyncMock()) as generate:
            for ids,user in [([self.ids[2]],None),([self.ids[0]],{'username':'outsider'})]:
                with self.assertRaises(HTTPException) as error:
                    await self.call(ids,user)
                self.assertEqual(error.exception.status_code,404)
            generate.assert_not_awaited()

    async def test_membership_revoked_while_generating(self):
        from app import job_queue
        async def revoke(*args,**kwargs):
            with job_queue._connect() as db:
                db.execute('DELETE FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s',(self.rooms[0],self.user))
            return 'Must not publish'
        with patch.object(away,'generate',side_effect=revoke):
            with self.assertRaises(HTTPException) as error: await self.call()
            self.assertEqual(error.exception.status_code,404)
        with job_queue._connect() as db:
            self.assertFalse(db.execute('SELECT 1 FROM people_chat.bob_chat_messages WHERE room_id=%s AND automated',(self.rooms[0],)).fetchone())

    async def test_duplicates_rejected_without_unselected_history_in_model(self):
        from app import job_queue
        with job_queue._connect() as db:
            db.execute('''INSERT INTO people_chat.bob_chat_messages(room_id,sender,body,automated,shared)
                VALUES (%s,%s,'Repeated answer!',true,'{"kind":"bob"}')''',(self.rooms[0],self.user))
        with patch.object(away,'generate',new=AsyncMock(return_value='repeated ANSWER.')) as generate:
            with self.assertRaises(HTTPException) as error: await self.call()
            self.assertEqual(error.exception.status_code,503)
            self.assertEqual(generate.await_count,2)
            self.assertEqual(generate.call_args_list[0].args[2],[])
            self.assertEqual(generate.call_args_list[1].args[2],['repeated ANSWER.'])
            self.assertIs(generate.call_args_list[0].kwargs['budget'],generate.call_args_list[1].kwargs['budget'])
            self.assertNotIn('Repeated answer',generate.call_args.args[0])

    async def test_inbox_context_is_own_only_and_used(self):
        from app import job_queue
        put=next(r.endpoint for r in self.router.routes if r.path.endswith('/bob-settings') and 'PUT' in r.methods)
        get=next(r.endpoint for r in self.router.routes if r.path.endswith('/bob-settings') and 'GET' in r.methods)
        put(self.rooms[0],bob.InboxSettings(instructions='Keep answers concise for this project'),{'username':self.user})
        with job_queue._connect() as db:
            db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES (%s,%s)',(self.rooms[0],self.user+'-peer'))
            db.execute('INSERT INTO people_chat.bob_chat_bob_context(room_id,username,instructions) VALUES (%s,%s,%s)',(self.rooms[0],self.user+'-peer','OTHER MEMBER PRIVATE INSTRUCTIONS'))
        self.assertEqual(get(self.rooms[0],Response(),{'username':self.user})['instructions'],'Keep answers concise for this project')
        async def generate(instructions,*args,**kwargs):
            self.assertIn('Keep answers concise',instructions)
            self.assertNotIn('OTHER MEMBER PRIVATE',instructions)
            return 'Fresh contextual answer'
        with patch.object(away,'generate',side_effect=generate): await self.call()

    async def test_deleted_selected_message_prevents_publication(self):
        from app import job_queue
        async def delete(*args,**kwargs):
            with job_queue._connect() as db: db.execute('DELETE FROM people_chat.bob_chat_messages WHERE id=%s',(self.ids[0],))
            return 'Must not publish'
        with patch.object(away,'generate',side_effect=delete):
            with self.assertRaises(HTTPException) as error: await self.call()
            self.assertEqual(error.exception.status_code,404)

if __name__=='__main__': unittest.main()
