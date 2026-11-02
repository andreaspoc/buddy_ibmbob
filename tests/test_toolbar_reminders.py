import asyncio
import json
import unittest
from unittest.mock import MagicMock, AsyncMock, patch
from pydantic import ValidationError
from app import toolbar_reminders as reminders, app_actions

class ReminderTests(unittest.TestCase):
    def test_reminder_is_identity_bound(self):
        args = reminders.CreateReminder(title='Call the test supplier')
        with self.assertRaises(PermissionError): reminders.create('alice',args,{})
        with self.assertRaises(PermissionError): reminders.create('alice',args,{'username':'bob','workspace_id':'a','assistant_message_id':'b'})
        for value in [{'title':' '},{'title':'Fixture','username':'bob'},{'title':'Fixture','color':'red'}]:
            with self.assertRaises(ValidationError): reminders.CreateReminder(**value)

    def test_save_is_retry_safe_and_scoped_to_owned_conversation(self):
        db=MagicMock();db.__enter__.return_value=db
        db.execute.return_value.fetchone.return_value={'id':5,'title':'Call the test supplier','color':'butter'}
        context={'username':'alice','workspace_id':'a'*32,'assistant_message_id':'reply'}
        with patch.object(reminders,'ensure_schema'),patch.object(reminders.job_queue,'_connect',return_value=db),patch('app.sessions.get_session') as session:
            saved=reminders.create('alice',reminders.CreateReminder(title='Call the test supplier'),context)
        session.assert_called_once_with('a'*32,'alice')
        sql,params=db.execute.call_args.args
        self.assertIn('ON CONFLICT (username,session_id,message_id,reminder_index)',sql)
        self.assertEqual(params,('alice','Call the test supplier','butter','a'*32,'reply',0))
        self.assertTrue(saved['pinned'])

    def test_tool_emits_only_after_persisting(self):
        emit=AsyncMock();ctx={'username':'alice','workspace_id':'a'*32,'assistant_message_id':'reply','emit':emit}
        payload={'action':'call','tool':'reminders_create','arguments':{'title':'Fixture reminder'}}
        with patch.object(reminders,'create',return_value={'id':5,'title':'Fixture reminder','saved':True,'pinned':True}):
            result=asyncio.run(app_actions.dispatch('alice',payload,ctx))
        self.assertTrue(json.loads(result['content'][0]['text'])['saved'])
        emit.assert_awaited_once_with({'type':'app_action','action':'reminders_changed','reminder_id':5})
        emit.reset_mock()
        with patch.object(reminders,'create',side_effect=RuntimeError('Failed write')):
            with self.assertRaises(RuntimeError):asyncio.run(app_actions.dispatch('alice',payload,ctx))
        emit.assert_not_awaited()

    def test_direct_request_only_handles_explicit_standalone_commands(self):
        for prompt,title in [('remind me to ask about Keycloak Databases','Ask about Keycloak Databases'),('Bob, please make a reminder to call Maria','Call Maria'),('create a reminder: Review the report tomorrow','Review the report tomorrow')]:
            self.assertEqual(reminders.explicit_reminder_title({'prompt':prompt}),title)
        for prompt in ['explain how reminders work','remind me about this','The document says: remind me to call Maria','remind me to call Maria and also research the company']:
            self.assertIsNone(reminders.explicit_reminder_title({'prompt':prompt}))
        self.assertIsNone(reminders.explicit_reminder_title({'prompt':'remind me to call Maria','mode':'presentation'}))

    def test_direct_request_saves_before_confirmation(self):
        recorder=MagicMock();recorder.record_event=AsyncMock(return_value=True);recorder.finish=AsyncMock()
        job={'username':'alice','payload':{'prompt':'remind me to call Maria'}}
        context={'username':'alice','workspace_id':'a'*32,'assistant_message_id':'reply'}
        with patch.object(reminders,'create',return_value={'id':5,'title':'Call Maria'}):
            self.assertTrue(asyncio.run(reminders.handle_direct_request(job,recorder,context)))
        events=[call.args[0] for call in recorder.record_event.call_args_list]
        self.assertEqual(events[1]['action'],'reminders_changed')
        self.assertIn('Call Maria',events[2]['text'])
        recorder.finish.assert_awaited_once_with({'type':'done'})
        recorder.record_event.reset_mock();recorder.finish.reset_mock()
        with patch.object(reminders,'create',side_effect=RuntimeError('Failed write')):
            with self.assertRaises(RuntimeError):asyncio.run(reminders.handle_direct_request(job,recorder,context))
        recorder.finish.assert_not_awaited()
        self.assertEqual(recorder.record_event.await_count,1)

    def test_reminder_list_is_owner_scoped(self):
        db=MagicMock();db.execute.return_value.fetchall.return_value=[]
        reminders.notifications(db,'alice')
        sql,params=db.execute.call_args.args
        self.assertIn('WHERE n.username=%s',sql)
        self.assertEqual(params,('alice','alice'))

if __name__=='__main__':unittest.main()
