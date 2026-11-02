"""Synthetic specialist results; no provider calls or external writes."""
import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import HTTPException
from pydantic import ValidationError
from app import app_agents as agents, app_agent_capabilities as caps, app_actions

CTX = {'username': 'alice', 'workspace_id': 'synthetic-chat', 'assistant_message_id': 'synthetic-reply'}


class AppAgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        quota = patch('app.agent_budget.RunBudget.consume', new_callable=AsyncMock)
        self.quota = quota.start()
        self.addCleanup(quota.stop)

    def test_schema_cannot_override_identity_or_mix_sources(self):
        for args in [dict(username='other'), dict(endpoint='https://example.com'), dict(file_ids=['00000000-0000-0000-0000-000000000001']), dict(task='  '), dict(note_ids=[-1])]:
            with self.subTest(args=args), self.assertRaises(ValidationError):
                agents.Delegate.model_validate({'agent':'notes','task':'Summarize',**args})

    async def test_real_handoff_is_bounded_owner_scoped_and_reports_lifecycle(self):
        events = AsyncMock(); context = {**CTX, 'emit': events}
        with patch.object(agents,'require_available',return_value={'username':'alice'}), patch.object(agents,'sources',new_callable=AsyncMock,return_value={'notes':[{'id':7,'body':'Synthetic note data'}]}) as sources, patch('app.app_agent_runtime.complete',new_callable=AsyncMock,return_value='Synthetic findings') as inference:
            result = await agents.delegate('alice',{'agent':'notes','task':'Summarize note 7','note_ids':[7]},context)
        self.assertEqual(result['reply'],'Synthetic findings');self.assertFalse(result['applied'])
        self.assertIsNone(result['usage']['tokens'])
        self.assertEqual(sources.await_args_list[0].args[0],'alice');self.assertEqual(sources.await_count,2)
        prompt = inference.await_args.args[0]
        self.assertIn('Synthetic note data',prompt);self.assertNotIn('synthetic-chat',prompt)
        emitted = [c.args[0] for c in events.await_args_list]
        self.assertEqual([e['collaboration']['stage'] for e in emitted],['started','completed'])
        self.assertEqual(emitted[0]['id'],emitted[1]['id']);self.assertEqual(emitted[1]['status'],'completed')
        self.assertEqual(context['app_agent_calls'],1)

    async def test_denied_access_never_calls_model(self):
        with patch.object(agents,'require_available',side_effect=HTTPException(403)), patch('app.app_agent_runtime.complete',new_callable=AsyncMock) as inference:
            with self.assertRaises(HTTPException):await agents.delegate('alice',{'agent':'projects','task':'Review'},dict(CTX))
            inference.assert_not_awaited()
        with self.assertRaises(PermissionError):await agents.delegate('alice',{'agent':'notes','task':'Review'},{'username':'bob'})

    async def test_specialist_quota_denies_before_inference(self):
        from app.agent_budget import BudgetExceeded
        budget = MagicMock(username='alice')
        budget.consume = AsyncMock(side_effect=BudgetExceeded('Synthetic quota exhausted'))
        with patch('app.app_agent_runtime.complete', new_callable=AsyncMock) as inference:
            with self.assertRaises(BudgetExceeded):
                await agents.delegate('alice', {'agent':'notes','task':'Review'}, {**CTX,'agent_budget':budget})
            inference.assert_not_awaited()
        budget.consume.assert_awaited_once_with('specialist')

    async def test_specialist_reports_its_own_provider_usage(self):
        completion = {'reply':'Synthetic findings', 'usage':{'tokens':17,'cost':0.01,'tokens_basis':'input_output'}}
        with patch.object(agents,'require_available'), patch.object(agents,'sources',new_callable=AsyncMock,return_value={}), \
                patch('app.app_agent_runtime.complete',new_callable=AsyncMock,return_value=completion) as inference:
            result = await agents.delegate('alice', {'agent':'notes','task':'Review'}, dict(CTX))
        self.assertEqual(result['reply'], 'Synthetic findings')
        self.assertEqual(result['usage']['tokens'], 17)
        self.assertEqual(result['usage']['cost'], 0.01)
        self.assertTrue(inference.await_args.kwargs['with_usage'])

    async def test_direct_specialist_call_creates_and_reuses_owner_budget(self):
        context = dict(CTX)
        with patch.object(agents,'require_available'), patch.object(agents,'sources',new_callable=AsyncMock,return_value={}), \
                patch('app.app_agent_runtime.complete',new_callable=AsyncMock,return_value='Synthetic findings'):
            await agents.delegate('alice', {'agent':'notes','task':'Review'}, context)
            budget = context['agent_budget']
            await agents.delegate('alice', {'agent':'notes','task':'Review again'}, context)
        self.assertIs(context['agent_budget'], budget)
        self.assertEqual(budget.username, 'alice')
        self.assertEqual(self.quota.await_count, 2)

    async def test_failure_cancellation_and_revoke_do_not_return_findings(self):
        for failure, stage in [(RuntimeError('Synthetic failure'),'failed'),(asyncio.CancelledError(),'cancelled')]:
            emit=AsyncMock()
            with patch.object(agents,'require_available'),patch.object(agents,'sources',new_callable=AsyncMock,side_effect=failure):
                with self.assertRaises(type(failure)):await agents.delegate('alice',{'agent':'notes','task':'Review'},{**CTX,'emit':emit})
            self.assertEqual(emit.await_args.args[0]['collaboration']['stage'],stage)
        with patch.object(agents,'require_available',side_effect=[{},HTTPException(403)]),patch.object(agents,'sources',new_callable=AsyncMock,return_value={}),patch('app.app_agent_runtime.complete',new_callable=AsyncMock,return_value='Private findings'):
            with self.assertRaises(HTTPException):await agents.delegate('alice',{'agent':'notes','task':'Review'},dict(CTX))

    async def test_handoff_limit_and_no_external_agent_registration(self):
        with patch.object(agents,'require_available'),patch.object(agents,'sources',new_callable=AsyncMock) as sources:
            with self.assertRaises(ValueError):await agents.delegate('alice',{'agent':'notes','task':'Review'},{**CTX,'app_agent_calls':6})
            sources.assert_not_awaited()
        names={tool['name'] for tool in agents.tools()}
        self.assertEqual(names,{'app_agents_list','app_agents_delegate'})
        self.assertIn('NOT external A2A',agents.POLICY)

    async def test_app_tool_dispatch_and_source_permissions(self):
        with patch.object(agents,'delegate',new_callable=AsyncMock,return_value={'status':'completed','applied':False}) as delegate:
            result=await app_actions.dispatch('alice',{'action':'call','tool':'app_agents_delegate','arguments':{'agent':'notes','task':'Review'}},CTX)
            self.assertFalse(json.loads(result['content'][0]['text'])['applied']);self.assertEqual(delegate.await_args.args[0],'alice')
        with patch('app.office_action_client.office_request',new_callable=AsyncMock,side_effect=HTTPException(404)):
            with self.assertRaises(HTTPException):await agents.sources('alice',agents.Delegate(agent='office',task='Review',file_ids=['00000000-0000-0000-0000-000000000001']))

    def test_snapshot_bound_includes_json_escaping(self):
        result=agents.bounded({'body': '\"'*20000},8000)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(json.dumps(result,ensure_ascii=False)),8000)

    def test_signed_context_is_purpose_body_and_time_bound(self):
        import jwt
        with patch.dict(os.environ,{'BUDDY_APP_AGENT_SECRET':'s'*40}):
            raw, token=caps.encode('alice',{'project_id':7})
            self.assertEqual(caps.verify('Bearer '+token,raw),'alice')
            with self.assertRaises(HTTPException):caps.verify('Bearer '+token,b'{"project_id":8}')
            claims=jwt.decode(token,'s'*40,algorithms=['HS256'],audience='buddy-project-agent-read')
            for changes in [{'aud':'buddy-office-actions'},{'exp':claims['iat']+3600},{'sub':''}]:
                forged=jwt.encode({**claims,**changes},'s'*40,algorithm='HS256')
                with self.assertRaises(HTTPException):caps.verify('Bearer '+forged,raw)


if __name__=='__main__':unittest.main()
