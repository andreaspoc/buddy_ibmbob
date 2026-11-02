"""Real PostgreSQL fixture: save/read/retry a private note and remove it afterwards."""
import asyncio,json,os,unittest
from datetime import datetime,timedelta,timezone
from uuid import uuid4
from fastapi import HTTPException
from app import app_actions as actions,notes,sessions,job_queue

@unittest.skipUnless(os.getenv('DATABASE_URL'),'Requires application PostgreSQL')
class AppActionsIntegration(unittest.IsolatedAsyncioTestCase):
    async def test_private_note_roundtrip_retry_and_calendar_filter(self):
        owner='voice-note-fixture-'+uuid4().hex
        other='voice-note-other-'+uuid4().hex
        session=await asyncio.to_thread(sessions.create_session,owner)
        context={'username':owner,'workspace_id':session['id'],'assistant_message_id':'fixture-reply','timezone':'Europe/Athens'}
        payload={'action':'call','tool':'notes_create','arguments':{'title':'Synthetic voice discussion fixture','body':'Explicit test note; not operational data.','tags':['Fixture'],'collection':'Synthetic Project Alpha','color':'sky'}}
        try:
            first=json.loads((await actions.dispatch(owner,payload,context))['content'][0]['text'])
            second=json.loads((await actions.dispatch(owner,payload,context))['content'][0]['text'])
            self.assertTrue(first['saved']);self.assertEqual(first['id'],second['id'])
            self.assertEqual(first['collection'],'Synthetic Project Alpha');self.assertEqual(first['color'],'sky')
            result=await asyncio.to_thread(actions.list_owned_notes,owner,actions.ListNotes(created_on='today'),'Europe/Athens')
            self.assertEqual(result['total'],1);self.assertEqual(result['items'][0]['id'],first['id'])
            result=await asyncio.to_thread(actions.list_owned_notes,other,actions.ListNotes(),'Europe/Athens')
            self.assertEqual(result['total'],0)
            with self.assertRaises(HTTPException):await asyncio.to_thread(actions.get_owned_note,other,actions.GetNote(note_id=first['id']))
            actual=await asyncio.to_thread(actions.get_owned_note,owner,actions.GetNote(note_id=first['id']))
            self.assertEqual(actual['body'],payload['arguments']['body'])
            _,start,_=actions.local_day_bounds('today','Europe/Athens')
            with job_queue._connect() as db:
                db.execute('UPDATE bob_notes SET created_at=%s,updated_at=now() WHERE username=%s AND id=%s',(start-timedelta(hours=1),owner,first['id']))
            result=await asyncio.to_thread(actions.list_owned_notes,owner,actions.ListNotes(created_on='today'),'Europe/Athens')
            self.assertEqual(result['total'],0,'Editing today must not count as creating today')
        finally:
            with job_queue._connect() as db:
                db.execute('DELETE FROM bob_notes WHERE username=%s',(owner,))
                db.execute('DELETE FROM bob_conversation_history WHERE username=%s AND session_id=%s',(owner,session['id']))
                db.execute('DELETE FROM bob_conversations WHERE username=%s AND id=%s',(owner,session['id']))

if __name__=='__main__':unittest.main()
