"""Synthetic fixtures: identity-bound Notes tools, calendar dates and retry safety."""
import asyncio,json,tempfile,unittest
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import AsyncMock,MagicMock,patch
from pydantic import ValidationError
from app import app_actions as actions,notes

class AppActionTests(unittest.IsolatedAsyncioTestCase):
    def test_today_uses_local_midnight_and_dst(self):
        day,start,end=actions.local_day_bounds('today','Europe/Athens',now=datetime(2026,10,15,22,30,tzinfo=timezone.utc))
        self.assertEqual(day,'2026-10-16')
        self.assertEqual(start,datetime(2026,10,15,21,tzinfo=timezone.utc))
        self.assertEqual(end,datetime(2026,10,16,21,tzinfo=timezone.utc))
        _,start,end=actions.local_day_bounds('2026-03-29','Europe/Athens')
        self.assertEqual((end-start).total_seconds(),23*3600)
    def test_no_caller_selected_owner_or_source(self):
        for model,args in [(actions.ListNotes,{'username':'other'}),(actions.GetNote,{'note_id':1,'username':'other'}),(actions.CreateNote,{'title':'Fixture','body':'Fixture','source_session_id':'other'})]:
            with self.assertRaises(ValidationError):model.model_validate(args)
    def test_list_is_owner_scoped_and_creation_filtered(self):
        db=MagicMock();db.__enter__.return_value=db
        db.execute.return_value.fetchone.return_value={'total':0}
        db.execute.return_value.fetchall.return_value=[]
        with patch.object(notes,'ensure_schema'),patch.object(notes.job_queue,'_connect',return_value=db):
            result=actions.list_owned_notes('alice',actions.ListNotes(created_on='2026-10-16',query='100%'), 'Europe/Athens')
        sql,args=db.execute.call_args_list[1].args
        self.assertIn('username=%s',sql);self.assertIn('created_at>=%s AND created_at<%s',sql)
        self.assertNotIn('updated_at>=',sql);self.assertEqual(args[0],'alice')
        self.assertIn('\\%',args[3]);self.assertEqual(result['total'],0)
    def test_create_preserves_selected_collection_and_draft_color(self):
        ctx={'username':'alice','workspace_id':'a'*32,'assistant_message_id':'selection-reply'}
        saved={'id':42,'title':'Chosen draft','body':'Preserved source text','collection':'Project Alpha','color':'sky'}
        with patch.object(notes,'create_note',return_value=saved) as create:
            result=actions.save_owned_note('alice',actions.CreateNote(title=saved['title'],body=saved['body'],collection=' Project Alpha ',color='sky',note_index=1),ctx)
        body=create.call_args.args[0]
        self.assertEqual(body.collection,'Project Alpha');self.assertEqual(body.color,'sky')
        self.assertEqual(body.source_note_index,1);self.assertTrue(result['saved'])
        with patch.object(notes,'create_note',return_value={**saved,'collection':'Other'}):
            with self.assertRaisesRegex(ValueError,'different collection'):
                actions.save_owned_note('alice',actions.CreateNote(title=saved['title'],body=saved['body'],collection='Project Alpha'),ctx)
        with patch.object(notes,'create_note',return_value=saved) as create:
            actions.save_owned_note('alice',actions.CreateNote(title=saved['title'],body=saved['body']),ctx)
        self.assertNotIn('collection',create.call_args.args[0].model_fields_set,'Omitting a collection preserves the normal default')

    async def test_create_uses_fixed_source_and_notifies_only_after_success(self):
        emit=AsyncMock();ctx={'username':'alice','workspace_id':'a'*32,'assistant_message_id':'reply-fixture','timezone':'Europe/Athens','emit':emit}
        saved={'id':41,'title':'Fixture','body':'Discussion summary'}
        with patch.object(notes,'create_note',return_value=saved) as create:
            result=await actions.dispatch('alice',{'action':'call','tool':'notes_create','arguments':{'title':'Fixture','body':'Discussion summary'}},ctx)
        self.assertTrue(json.loads(result['content'][0]['text'])['saved'])
        body=create.call_args.args[0]
        self.assertEqual(body.source_session_id,'a'*32);self.assertEqual(body.source_message_id,'reply-fixture');self.assertEqual(body.source_note_index,0)
        self.assertEqual(create.call_args.kwargs['user'],{'username':'alice'})
        emit.assert_awaited_once_with({'type':'app_action','action':'notes_changed','note_id':41,'note_title':'Fixture','note_color':'butter','note_collection':''})
        emit.reset_mock()
        with patch.object(notes,'create_note',side_effect=RuntimeError('Fixture database failure')):
            with self.assertRaises(RuntimeError):await actions.dispatch('alice',{'action':'call','tool':'notes_create','arguments':{'title':'Fixture','body':'Discussion summary'}},ctx)
        emit.assert_not_awaited()
    async def test_write_requires_owned_turn_and_retries_do_not_claim_revised_content(self):
        arguments=actions.CreateNote(title='Fixture',body='Fixture body')
        with self.assertRaises(PermissionError):actions.save_owned_note('alice',arguments,{})
        with self.assertRaises(PermissionError):await actions.dispatch('alice',{'action':'tools'},{'username':'bob'})
        ctx={'username':'alice','workspace_id':'a'*32,'assistant_message_id':'reply'}
        with patch.object(notes,'create_note',return_value={'id':1,'title':'Old title','body':'Old body'}):
            with self.assertRaises(ValueError):actions.save_owned_note('alice',arguments,ctx)
    async def test_builtin_tools_are_discoverable_without_external_mcp_configuration(self):
        from app import mcp_broker
        from app import mcp_access
        ctx={'username':'alice','timezone':'Europe/Athens'}
        token=actions.action_context.set(ctx)
        try:
            with tempfile.TemporaryDirectory() as directory,patch.object(mcp_broker,'bootstrap_registry'),patch.object(mcp_access,'allowed_servers',return_value={}),patch.object(actions,'list_owned_notes',return_value={'items':[],'total':0}) as listing:
                root=Path(directory)
                async with mcp_broker.mcp_broker(username='alice',workspace=str(root/'workspace'),user_home=str(root/'home')) as socket:
                    servers=await mcp_broker.request(socket,{'action':'servers'})
                    self.assertIn('buddy-app',[item['name'] for item in servers])
                    tools=await mcp_broker.request(socket,{'action':'tools','server':'buddy-app'})
                    self.assertTrue({'notes_list','notes_get','notes_create'}.issubset({tool['name'] for tool in tools}))
                    result=await mcp_broker.request(socket,{'action':'call','server':'buddy-app','tool':'notes_list','arguments':{'created_on':'today'}})
                    self.assertEqual(json.loads(result['content'][0]['text'])['total'],0)
                    self.assertEqual(listing.call_args.args[0],'alice');self.assertEqual(listing.call_args.args[2],'Europe/Athens')
                    with self.assertRaises(PermissionError):await mcp_broker.request(socket,{'action':'call','server':'buddy-app','tool':'notes_list','arguments':{'username':'bob'}})
                    config=json.loads((root/'workspace/.bob/mcp.json').read_text())
                    self.assertIn('buddy-app',config['mcpServers'])
                    async with mcp_broker.open_session(config['mcpServers']['buddy-app'],user_home=str(root/'home'),workspace=str(root/'workspace')) as native:
                        native_tools=await native.list_tools()
                        self.assertIn('notes_list',[item.name for item in native_tools.tools])
                        native_result=await native.call_tool('notes_list',{'created_on':'today'})
                        self.assertFalse(native_result.isError)
                        self.assertEqual(json.loads(native_result.content[0].text)['total'],0)
        finally:actions.action_context.reset(token)

if __name__=='__main__':unittest.main()
