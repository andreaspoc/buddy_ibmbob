"""Office native plans consult internal agents without granting editing authority."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch
from app import office_assistant as oa, app_agents


class OfficeCollaborationTests(unittest.IsolatedAsyncioTestCase):
    async def test_consult_then_review_and_show_real_progress(self):
        req=oa.Draft(prompt='Make a report from my saved launch notes',context={'kind':'word','text':'Keep original'})
        first={'version':1,'kind':'word','reply':'Checking notes','actions':[], 'consultations':[{'agent':'notes','task':'Summarize launch notes','query':'launch'}]}
        final={'version':1,'kind':'word','reply':'Review this report','actions':[{'type':'insert_blocks','position':'end','blocks':[{'type':'paragraph','text':'Synthetic reviewed contribution'}]}]}
        request=type('Request',(),{'is_disconnected':AsyncMock(return_value=False)})()
        async def delegated(username,args,context):
            self.assertEqual(username,'alice');self.assertNotIn('Keep original',json.dumps(args))
            await context['emit'](app_agents.collaboration_event('synthetic-handoff','notes','started'))
            await context['emit'](app_agents.collaboration_event('synthetic-handoff','notes','completed'))
            return {'reply':'Synthetic launch findings','applied':False}
        with patch.object(oa.office_ai,'run_acp',new_callable=AsyncMock,side_effect=[json.dumps(first),json.dumps(final)]) as model,patch.object(app_agents,'delegate',side_effect=delegated):
            events=[json.loads(e) async for e in oa.draft_events(req,oa.completion_for(req,'docx'),'docx',request,'alice')]
        self.assertEqual([e['collaboration']['stage'] for e in events if 'collaboration' in e],['started','completed'])
        plans=[e['plan'] for e in events if e['type']=='plan']
        self.assertEqual(len(plans),1);self.assertNotIn('consultations',plans[0]);self.assertEqual(plans[0]['actions'][0]['blocks'][0]['text'],'Synthetic reviewed contribution')
        self.assertIn('Synthetic launch findings',model.await_args.args[0].messages[0].content)
        self.assertEqual(events[-1]['type'],'done')

    def test_specialist_findings_fit_maximum_office_request_budget(self):
        results=app_agents.bounded([{'reply':'"'*24000},{'reply':'x'*24000}],8000)
        handoff='Internal specialist findings: '+json.dumps(results,ensure_ascii=False)
        for extension,kind in [('docx','word'),('xlsx','cell'),('pptx','slide')]:
            req=oa.Draft(prompt='x'*12000,context={'kind':kind})
            completion=oa.completion_for(req,extension,reserve=len(handoff))
            self.assertLessEqual(len(handoff)+len(completion.messages[0].content),oa.office_ai.MAX_INPUT)

    async def test_failed_specialist_does_not_fake_findings_or_apply(self):
        req=oa.Draft(prompt='Use the project portfolio',context={'kind':'word'})
        consult={'version':1,'kind':'word','reply':'Checking','actions':[], 'consultations':[{'agent':'projects','task':'Review'}]}
        answer={'version':1,'kind':'word','reply':'Project context is unavailable; no changes proposed.','actions':[]}
        request=type('Request',(),{'is_disconnected':AsyncMock(return_value=False)})()
        with patch.object(oa.office_ai,'run_acp',new_callable=AsyncMock,side_effect=[json.dumps(consult),json.dumps(answer)]) as model,patch.object(app_agents,'delegate',new_callable=AsyncMock,side_effect=PermissionError()):
            events=[json.loads(e) async for e in oa.draft_events(req,oa.completion_for(req,'docx'),'docx',request,'alice')]
        self.assertEqual(events[-1]['type'],'done');self.assertEqual(next(e['plan']['actions'] for e in events if e['type']=='plan'),[])
        self.assertIn('No source findings',model.await_args.args[0].messages[0].content)

if __name__=='__main__':unittest.main()
