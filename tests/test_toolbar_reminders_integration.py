"""Disposable PostgreSQL fixture for private reminder persistence and dismissal."""
import asyncio,json,os,unittest
from uuid import uuid4
from app import app_actions,toolbar_reminders,notification_inbox,sessions,job_queue

@unittest.skipUnless(os.getenv('DATABASE_URL'),'Requires PostgreSQL')
class ToolbarReminderIntegration(unittest.IsolatedAsyncioTestCase):
    async def test_tool_pin_reload_retry_isolation_and_dismiss(self):
        owner='reminder-fixture-'+uuid4().hex
        session=sessions.create_session(owner)
        context={'username':owner,'workspace_id':session['id'],'assistant_message_id':'fixture-reply'}
        payload={'action':'call','tool':'reminders_create','arguments':{'title':'Synthetic reminder fixture','color':'mint'}}
        try:
            first=json.loads((await app_actions.dispatch(owner,payload,context))['content'][0]['text'])
            second=json.loads((await app_actions.dispatch(owner,payload,context))['content'][0]['text'])
            self.assertEqual(first['id'],second['id']);self.assertTrue(first['saved'])
            notification_inbox.ensure_schema()
            with job_queue._connect() as db:
                items=toolbar_reminders.notifications(db,owner)
                self.assertEqual(len(items),1);self.assertIsNone(items[0]['read_at'])
                self.assertEqual(items[0]['title'],'Synthetic reminder fixture')
                self.assertEqual(toolbar_reminders.notifications(db,'other-'+owner),[])
            notice_id='reminder:'+str(first['id'])
            self.assertFalse(notification_inbox.mark_read('other-'+owner,notice_id))
            self.assertTrue(notification_inbox.mark_read(owner,notice_id))
            with job_queue._connect() as db:
                self.assertIsNotNone(toolbar_reminders.notifications(db,owner)[0]['read_at'])
            with self.assertRaises(PermissionError):
                await app_actions.dispatch('other-'+owner,payload,context)
        finally:
            with job_queue._connect() as db:
                db.execute('DELETE FROM bob_notification_reads WHERE username=%s',(owner,))
                db.execute('DELETE FROM bob_toolbar_reminders WHERE username=%s',(owner,))
                db.execute('DELETE FROM bob_conversation_history WHERE username=%s AND session_id=%s',(owner,session['id']))
                db.execute('DELETE FROM bob_conversations WHERE username=%s AND id=%s',(owner,session['id']))

if __name__=='__main__':unittest.main()
